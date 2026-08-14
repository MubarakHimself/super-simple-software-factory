/**
 * The claude adapter (spec 1.3): `claude -p --input-format stream-json
 * --output-format stream-json --verbose`, one process for the whole Session
 * (W1-B6: "a process-per-skill cannot serve the long-session entry way").
 *
 * Verified live against the real binary on this box (2026-08-13 night, K11):
 * a single such process, fed one JSON line per turn on stdin, answers turn 1,
 * stays alive, and answers a second turn fed after the first's `result` line
 * - confirming the long-lived, multi-turn stdin-duplex contract this adapter
 * depends on (see the K11 build notes for the exact probe transcript). The
 * stream-json event shapes below (`system/init`, `assistant` message content
 * blocks of type `thinking`/`text`/`tool_use`, `user` message content blocks
 * of type `tool_result`, `result`, `rate_limit_event`) are copied from that
 * same live capture, not guessed.
 *
 * Mapping to `SessionEvent`:
 *  - assistant `text` block -> `{kind:"text"}` immediately (order-preserving:
 *    blocks are emitted in the array order the harness itself chose, so rule
 *    (b) - "pending text is always flushed before an ask is emitted" - holds
 *    for free, with no buffering needed on this side).
 *  - assistant `thinking` block -> dropped. Not part of the union, and
 *    surfacing chain-of-thought was never asked for.
 *  - assistant `tool_use` block named `AskUserQuestion` -> `{kind:"ask"}`
 *    immediately (it blocks the harness on the operator - it cannot wait for
 *    a `tool_result` that will never come without one).
 *  - any other `tool_use` block -> held pending until its matching
 *    `tool_result` arrives, THEN emitted as one `{kind:"tool"}` with the
 *    real `ok`/`fail` from `tool_result.is_error` (never a string-scan
 *    heuristic - the same rule Runs' work log follows, spec 2.5). A tool
 *    left pending when the session ends is flushed as `status:"neutral"`
 *    ("we do not know" - never coerced to ok or fail).
 *  - `result` -> `opts.onIdle()`, which store.ts records as the `idle` event
 *    (types.ts). This line IS the turn boundary: the reply is finished and
 *    nothing runs until the next turn. Dropping it entirely - as this adapter
 *    first did - left a finished turn unmarked, so the Session header kept
 *    claiming `Working` after the harness had stopped.
 *  - `system`, `rate_limit_event` -> no SessionEvent (nothing in the union
 *    fits them, and inventing one would be exactly what the mock-data ban
 *    forbids applied to event shape instead of numbers).
 *
 * Not live-verified in this chunk (flagged plainly, K12's job to prove):
 * the exact `AskUserQuestion` tool_use `input` schema, and the answer ->
 * `tool_result` resume round-trip below. No prompt in this chunk's testing
 * budget happened to trigger a real ask; the mapping is written defensively
 * against the two most plausible shapes (`{question, options}` and
 * `{questions:[{question, options}]}`) rather than left unhandled.
 */
import { spawn } from "node:child_process";
import type { AdapterHandle, AdapterStartOptions } from "../adapter.ts";
import { clipDetail, clipTitle, stripShellWrapper } from "../clip.ts";
import type { SessionEvent } from "../types.ts";

interface PendingTool {
  name: string;
  input: unknown;
}

const STDERR_TAIL_CHARS = 4000;

function summarizeInput(name: string, input: unknown): string {
  if (name === "Bash" && input && typeof input === "object" && "command" in input) {
    return stripShellWrapper(String((input as { command: unknown }).command ?? ""));
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.pattern === "string") return obj.pattern;
    if (typeof obj.command === "string") return obj.command;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function extractFiles(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.path;
  return typeof candidate === "string" ? [candidate] : undefined;
}

function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Defensive mapping - see this file's header. Returns null if `input`
 * doesn't look like an ask (caller then falls back to the ordinary tool
 * path). */
function toAskEvent(requestId: string, input: unknown): Extract<SessionEvent, { kind: "ask" }> | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const single = obj as { question?: unknown; options?: unknown };
  const nested = Array.isArray(obj.questions) ? (obj.questions[0] as Record<string, unknown> | undefined) : undefined;
  const question = single.question ?? nested?.question;
  const rawOptions = single.options ?? nested?.options;
  if (typeof question !== "string" || !Array.isArray(rawOptions)) return null;
  const options = rawOptions
    .map((o, i) => {
      if (typeof o === "string") return { id: o, label: o };
      if (o && typeof o === "object") {
        const oo = o as Record<string, unknown>;
        const label = typeof oo.label === "string" ? oo.label : typeof oo.id === "string" ? oo.id : `Option ${i + 1}`;
        const id = typeof oo.id === "string" ? oo.id : label;
        const description = typeof oo.description === "string" ? oo.description : undefined;
        return { id, label, description };
      }
      return { id: String(i), label: String(o) };
    })
    .slice(0, 8);
  return { kind: "ask", requestId, question, options };
}

export function startClaude(opts: AdapterStartOptions): AdapterHandle {
  const argv = [...opts.baseArgs, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  const child = spawn(opts.file, argv, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stopped = false;
  let stdoutBuf = "";
  let stderrTail = "";
  const pendingTools = new Map<string, PendingTool>();
  const pendingAsks = new Set<string>();

  function sendUserText(text: string): void {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    child.stdin.write(`${line}\n`);
  }

  function flushUnresolvedTools(): void {
    for (const [id, tool] of pendingTools) {
      if (pendingAsks.has(id)) continue; // an unanswered ask stays an ask, not a neutral tool
      opts.onEvent({
        kind: "tool",
        title: clipTitle(tool.name),
        detail: clipDetail(summarizeInput(tool.name, tool.input)),
        files: extractFiles(tool.input),
        status: "neutral",
      });
    }
    pendingTools.clear();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf-8");
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      handleLine(line);
    }
  });

  function handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a stray non-JSON line never crashes the bridge
    }
    const type = obj.type;
    if (type === "assistant") {
      const message = obj.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          opts.onEvent({ kind: "text", text: b.text, streaming: false });
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          const ask = b.name === "AskUserQuestion" ? toAskEvent(b.id, b.input) : null;
          if (ask) {
            pendingTools.set(b.id, { name: b.name, input: b.input });
            pendingAsks.add(b.id);
            opts.onEvent(ask);
          } else {
            pendingTools.set(b.id, { name: b.name, input: b.input });
          }
        }
        // "thinking" blocks: dropped, per this file's header.
      }
    } else if (type === "user") {
      const message = obj.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const id = b.tool_use_id;
          const pending = pendingTools.get(id);
          pendingTools.delete(id);
          if (pendingAsks.has(id)) {
            // The operator's answer round-tripped back as a tool_result -
            // already conveyed as the ask's own resolution; no separate
            // tool event (an ask is not also a tool call in the timeline).
            pendingAsks.delete(id);
            continue;
          }
          const name = pending?.name ?? "Tool";
          opts.onEvent({
            kind: "tool",
            title: clipTitle(name),
            detail: clipDetail(summarizeInput(name, pending?.input) || resultToText(b.content)),
            files: extractFiles(pending?.input),
            status: b.is_error === true ? "fail" : "ok",
          });
        }
      }
    } else if (type === "result") {
      // The turn boundary (see header): what a `queue`-mode input waits for,
      // and what store.ts records as `idle` so the header stops saying the
      // harness is working the moment it stops.
      opts.onIdle();
    }
    // "system" (init/hooks), "rate_limit_event": no SessionEvent, no idle
    // signal either - they can arrive mid-turn.
  }

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (error) => {
    opts.onEvent({ kind: "error", detail: clipDetail(error.message) });
  });

  child.on("exit", (code, signal) => {
    flushUnresolvedTools();
    if (code !== 0 && code !== null && stderrTail.trim()) {
      opts.onEvent({ kind: "error", detail: clipDetail(stderrTail.trim()) });
    }
    opts.onEvent({ kind: "exit", code: code ?? (signal ? 1 : 0) });
  });

  sendUserText(opts.prompt);

  return {
    canSteer: true,
    input(text) {
      if (stopped || child.exitCode !== null) return false;
      sendUserText(text);
      return true;
    },
    answer(requestId, value) {
      if (!pendingAsks.has(requestId)) return false;
      const content = value.optionId ?? value.text ?? "";
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: requestId, content, is_error: false }] },
      });
      child.stdin.write(`${line}\n`);
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      // Give the process a moment to exit on its own from the stdin close
      // before forcing it - `exit`'s handler above still fires either way
      // and is what actually emits the `exit` SessionEvent.
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill();
          } catch {
            /* already dead */
          }
        }
      }, 3000);
    },
  };
}
