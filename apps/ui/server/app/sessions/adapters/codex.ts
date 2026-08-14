/**
 * The codex adapter (spec 1.3): `codex exec --json`.
 *
 * Deliberate, flagged departure from "one long-lived harness process per
 * Session" read literally: `codex exec` has no persistent stdin-duplex mode
 * the way `claude -p --input-format stream-json` does (confirmed by reading
 * `codex exec --help` / `codex exec resume --help` on this box - there is no
 * flag that keeps a turn's process alive waiting for the next prompt on
 * stdin). What codex DOES support, and what this adapter uses, is
 * `codex exec resume <thread_id> "<prompt>" --json`, which continues the
 * same conversation (same context, same thread) in a fresh process. So the
 * Session, as store.ts sees it through the `AdapterHandle` interface, is
 * still one long-lived, steerable conversation - the "no shell-visible
 * command line changes turn to turn" invariant (spec 1.2) holds, and steer
 * still works (a queued/steered turn spawns `exec resume` exactly like an
 * ordinary next turn) - it is only codex's OWN process boundary that is
 * per-turn rather than per-Session, which is invisible to everything above
 * this adapter. Confirmed live on this box: `codex exec --json` returns a
 * `thread.started` with a real `thread_id`, and `codex exec resume
 * <thread_id> ...` is a documented, real subcommand for continuing it.
 *
 * Because each turn is its own process, a turn's process exiting is NORMAL
 * (the harness finished that turn and is waiting for the next one) and must
 * NOT be reported as the Session ending - `{kind:"exit"}` is only ever
 * emitted from `stop()` here, never from a per-turn child's own `exit`.
 *
 * Item mapping (`item.completed` only - `item.started` is the in-progress
 * half of the same two-phase report codex gives per item, mirrored from the
 * live capture in this chunk's build notes):
 *  - `agent_message` -> `{kind:"text"}`
 *  - `reasoning` -> dropped (codex's chain-of-thought equivalent; same
 *    reasoning as claude's `thinking` blocks)
 *  - `command_execution` -> `{kind:"tool"}`, `status` from the item's own
 *    `exit_code` (0 -> ok, anything else -> fail) - never a string-scan
 *  - anything else codex emits (`patch_apply`, `mcp_tool_call`, `error`, or
 *    a future item type this adapter has not seen) -> a generic `{kind:
 *    "tool"}` naming the item's own `type`, so nothing is silently dropped;
 *    an `error`-typed item additionally emits `{kind:"error"}`
 *
 * Not observed live in this chunk's testing: codex pausing an `exec` run
 * for an interactive approval/ask. With `--sandbox read-only` (this
 * adapter's default - see below), a disallowed action fails immediately
 * (`item.completed` with `status:"failed"`) rather than blocking on the
 * operator, so no `{kind:"ask"}` mapping exists here. Flagged for the
 * morning rather than guessed.
 */
import { spawn } from "node:child_process";
import type { AdapterHandle, AdapterStartOptions } from "../adapter.ts";
import { clipDetail, clipTitle, stripShellWrapper } from "../clip.ts";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  [key: string]: unknown;
}

function itemFiles(item: CodexItem): string[] | undefined {
  const candidate = item.path ?? item.file ?? item.file_path;
  if (typeof candidate === "string") return [candidate];
  if (Array.isArray(item.files) && item.files.every((f) => typeof f === "string")) return item.files as string[];
  return undefined;
}

export function startCodex(opts: AdapterStartOptions): AdapterHandle {
  let stopped = false;
  let threadId: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let queue: string[] = [];
  let turnInFlight = false;

  function emitItemCompleted(item: CodexItem): void {
    const type = item.type ?? "item";
    if (type === "agent_message") {
      if (typeof item.text === "string" && item.text.length > 0) {
        opts.onEvent({ kind: "text", text: item.text, streaming: false });
      }
      return;
    }
    if (type === "reasoning") return;
    if (type === "command_execution") {
      const ok = item.exit_code === 0;
      opts.onEvent({
        kind: "tool",
        title: "Ran a command",
        detail: clipDetail(stripShellWrapper(item.command ?? item.aggregated_output ?? "")),
        status: item.status === "failed" || !ok ? "fail" : "ok",
      });
      return;
    }
    if (type === "error") {
      opts.onEvent({ kind: "error", detail: clipDetail(String(item.text ?? item.aggregated_output ?? "codex reported an error")) });
      return;
    }
    // Unknown/other item types (patch_apply, mcp_tool_call, ...): shown
    // honestly rather than dropped - see this file's header.
    opts.onEvent({
      kind: "tool",
      title: clipTitle(type),
      detail: clipDetail(JSON.stringify(item).slice(0, 400)),
      files: itemFiles(item),
      status: item.status === "failed" ? "fail" : item.status === "completed" ? "ok" : "neutral",
    });
  }

  function runTurn(prompt: string): void {
    turnInFlight = true;
    const argv =
      threadId !== null
        ? [...opts.baseArgs, "exec", "resume", threadId, prompt, "--json", "--skip-git-repo-check"]
        : [...opts.baseArgs, "exec", "--json", "--skip-git-repo-check", prompt];
    child = spawn(opts.file, argv, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
          threadId = obj.thread_id;
        } else if (obj.type === "item.completed" && obj.item && typeof obj.item === "object") {
          emitItemCompleted(obj.item as CodexItem);
        }
        // "turn.started"/"turn.completed"/"item.started": no SessionEvent.
      }
    });

    let stderrTail = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-4000);
    });

    child.on("error", (error) => {
      opts.onEvent({ kind: "error", detail: clipDetail(error.message) });
      turnInFlight = false;
      drainQueue();
    });

    child.on("exit", (code) => {
      turnInFlight = false;
      if (code !== 0 && code !== null && stderrTail.trim() && !stopped) {
        opts.onEvent({ kind: "error", detail: clipDetail(stderrTail.trim()) });
      }
      if (stopped) {
        opts.onEvent({ kind: "exit", code: 0 });
      } else {
        opts.onIdle(); // turn boundary - store.ts's queue-mode drains here
        drainQueue(); // this adapter's own steer-safety queue, independent of the above
      }
    });
  }

  function drainQueue(): void {
    if (stopped || turnInFlight) return;
    const next = queue.shift();
    if (next !== undefined) runTurn(next);
  }

  runTurn(opts.prompt);

  return {
    canSteer: true,
    input(text) {
      if (stopped) return false;
      queue.push(text);
      drainQueue();
      return true;
    },
    answer() {
      // No verified ask protocol for codex exec - see header. A `queue`d
      // plain-text answer via input() is the honest fallback; there is
      // nothing here to resume mid-tool-call.
      return false;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      queue = [];
      if (turnInFlight && child) {
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      } else {
        opts.onEvent({ kind: "exit", code: 0 });
      }
    },
  };
}
