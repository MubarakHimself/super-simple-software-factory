/**
 * Initialize this project — the surface that was missing.
 *
 * ── What was broken ────────────────────────────────────────────────────────
 * Both initialization endpoints existed and both worked, but the only place in
 * the app that ever CALLED them was inside `settings/AddProject.tsx` — the
 * Add-project modal's own sequence. So a project that was already registered
 * (added from the sidebar, from first run, or from `/add`, all of which open
 * `shell/AddProject.tsx`, which deliberately initializes nothing) had no way
 * to be initialized at all. The operator's report was exactly that: the
 * project is in the list, and there is no button. Home said "No factory here"
 * and stopped; Settings · Roster said "or `uv run` the sssf installer in the
 * repo", which is an instruction to leave the app.
 *
 * This panel is that button, and it is mounted wherever the app already
 * detected the absence. It is not a second Add-project journey: the project is
 * already registered, so all it does is read `/readiness` and offer the one or
 * two writes that are missing.
 *
 * ── What it shows while it runs ────────────────────────────────────────────
 * The jobs pattern, honestly: `POST` returns a `job_id`, the panel polls
 * `/api/app/jobs/:id` and renders the job's OWN lines as they arrive — the
 * installer's real stdout, not a spinner with an invented sentence. On exit 0
 * readiness is re-read and the detection row flips by itself. On any failure
 * the alert carries the server's error string or the job's own last lines and
 * exit code, verbatim.
 *
 * ── Two writes, in order ───────────────────────────────────────────────────
 * `init/factory` refuses on a folder that is not a repo yet (server-side, 409)
 * so when detection says "not a repo" the button runs `git init` first and the
 * installer second, in one press, reporting both. That is the same order
 * `settings/AddProject.tsx` uses; it is the server's rule, not this panel's.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../lib/api.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import "./onboarding.css";

/** `GET /api/app/projects/:id/readiness` — only the two facts this panel acts
 * on. The response carries more (harnesses, runs); nothing here reads it. */
interface Readiness {
  git: { is_repo: boolean; branch: string | null };
  factory: { config: boolean; adws: boolean };
}

interface JobStatus {
  state: "running" | "done" | "failed";
  exit_code: number | null;
  lines: string[];
  dropped: number;
}

const POLL_MS = 500;
/** How many of the job's lines the strip shows at once. The server already
 * caps its buffer at 500 and reports what it dropped; this is only how much of
 * that buffer is on screen, and it scrolls. */
const VISIBLE_LINES = 14;

type Phase =
  | { kind: "reading" }
  | { kind: "unreadable"; error: string }
  | { kind: "ready"; readiness: Readiness }
  | { kind: "running"; step: string; lines: string[]; dropped: number }
  | { kind: "failed"; step: string; error: string; lines: string[] }
  | { kind: "done"; readiness: Readiness };

function lastLines(lines: string[], count: number): string[] {
  return lines.length <= count ? lines : lines.slice(lines.length - count);
}

/** A finished job that failed, in its own words — exit code plus whatever it
 * last printed. Never a sentence this app invented. */
function jobFailure(job: JobStatus, step: string): string {
  const tail = lastLines(job.lines.filter((line) => line.trim()), 3);
  const code = job.exit_code === null ? "did not start" : `exited ${job.exit_code}`;
  return tail.length > 0 ? `${step} ${code} — ${tail.join(" / ")}` : `${step} ${code}, with no output.`;
}

export function InitializeFactory({
  projectId,
  projectName,
  onInitialized,
}: {
  projectId: string;
  projectName: string;
  /** Fired once, after readiness confirms the factory config is on disk — the
   * surfaces that mount this re-read their own data on it. */
  onInitialized?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  // The job keeps running in the server after this panel unmounts; this ref is
  // what stops the poll writing into a component that is gone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readReadiness = useCallback(
    () => apiGet<Readiness>(`/api/app/projects/${encodeURIComponent(projectId)}/readiness`),
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "reading" });
    readReadiness()
      .then((readiness) => {
        if (!cancelled) setPhase({ kind: "ready", readiness });
      })
      .catch((failure: Error) => {
        if (!cancelled) setPhase({ kind: "unreadable", error: failure.message });
      });
    return () => {
      cancelled = true;
    };
  }, [readReadiness]);

  /** Runs one job to completion, streaming its lines into `running` as they
   * arrive. Returns the finished status, or null if this panel went away. */
  const runJob = async (path: string, step: string): Promise<JobStatus | null> => {
    const handle = await apiPost<{ job_id: string }>(path, {});
    for (;;) {
      const status = await apiGet<JobStatus>(`/api/app/jobs/${encodeURIComponent(handle.job_id)}`);
      if (!alive.current) return null;
      setPhase({ kind: "running", step, lines: status.lines, dropped: status.dropped });
      if (status.state !== "running") return status;
      await new Promise((settle) => setTimeout(settle, POLL_MS));
    }
  };

  /** Always re-reads the folder first: a failed attempt may have left git
   * initialized, and "Try again" must not re-run a step that already
   * succeeded. One click resumes from wherever the folder actually is. */
  const initialize = async () => {
    setPhase({ kind: "reading" });
    let needsGit: boolean;
    try {
      const fresh = await readReadiness();
      if (!alive.current) return;
      if (fresh.factory.config) {
        setPhase({ kind: "done", readiness: fresh });
        onInitialized?.();
        return;
      }
      needsGit = !fresh.git.is_repo;
    } catch (failure) {
      if (alive.current) setPhase({ kind: "unreadable", error: (failure as Error).message });
      return;
    }
    setPhase({ kind: "running", step: needsGit ? "git init" : "the factory installer", lines: [], dropped: 0 });

    try {
      if (needsGit) {
        const git = await runJob(`/api/app/p/${encodeURIComponent(projectId)}/init/git`, "git init");
        if (!git) return;
        if (git.state !== "done") {
          setPhase({ kind: "failed", step: "git init", error: jobFailure(git, "git init"), lines: git.lines });
          return;
        }
      }

      const install = await runJob(`/api/app/p/${encodeURIComponent(projectId)}/init/factory`, "the factory installer");
      if (!install) return;
      if (install.state !== "done") {
        setPhase({
          kind: "failed",
          step: "the factory installer",
          error: jobFailure(install, "The factory installer"),
          lines: install.lines,
        });
        return;
      }

      const readiness = await readReadiness();
      if (!alive.current) return;
      if (!readiness.factory.config) {
        setPhase({
          kind: "failed",
          step: "the factory installer",
          error:
            "The installer exited 0 but adws/adw_sssf_config/sssf.config.yaml is still not there — the folder was not stamped.",
          lines: install.lines,
        });
        return;
      }
      setPhase({ kind: "done", readiness });
      onInitialized?.();
    } catch (failure) {
      if (!alive.current) return;
      // A refused POST (409 guard, missing installer) never becomes a job, so
      // there is no job output to show — only the server's one line.
      setPhase({ kind: "failed", step: "initialization", error: (failure as Error).message, lines: [] });
    }
  };

  const reread = () => {
    setPhase({ kind: "reading" });
    readReadiness()
      .then((readiness) => {
        if (alive.current) setPhase({ kind: "ready", readiness });
      })
      .catch((failure: Error) => {
        if (alive.current) setPhase({ kind: "unreadable", error: failure.message });
      });
  };

  /* ── the two rows, in whatever state this panel is in ──────────────────── */

  const rows: { tone: Tone; label: string; sentence: string }[] = (() => {
    if (phase.kind === "reading") {
      return [
        { tone: "idle" as Tone, label: "Git repository", sentence: "reading the folder…" },
        { tone: "idle" as Tone, label: "Factory initialized", sentence: "reading the folder…" },
      ];
    }
    if (phase.kind === "unreadable") {
      return [
        { tone: "fail" as Tone, label: "Git repository", sentence: "not read — " + phase.error },
        { tone: "idle" as Tone, label: "Factory initialized", sentence: "not read" },
      ];
    }
    if (phase.kind === "running") {
      return [
        { tone: "run" as Tone, label: "Git repository", sentence: `running ${phase.step}…` },
        { tone: "run" as Tone, label: "Factory initialized", sentence: `running ${phase.step}…` },
      ];
    }
    if (phase.kind === "failed") {
      return [
        { tone: "fail" as Tone, label: "Git repository", sentence: `${phase.step} did not finish` },
        { tone: "fail" as Tone, label: "Factory initialized", sentence: "no — the folder was not stamped" },
      ];
    }
    const readiness = phase.readiness;
    return [
      {
        tone: readiness.git.is_repo ? ("ok" as Tone) : ("warn" as Tone),
        label: "Git repository",
        sentence: readiness.git.is_repo
          ? // `branch` is null only on a detached HEAD now (gitro.ts uses
            // `git branch --show-current`, which names the branch even before
            // the first commit).
            `yes — ${readiness.git.branch ? `on branch ${readiness.git.branch}` : "on a detached HEAD"}`
          : "no — the installer refuses on a folder that is not a repo, so git init runs first",
      },
      {
        tone: readiness.factory.config ? ("ok" as Tone) : ("warn" as Tone),
        label: "Factory initialized",
        sentence: readiness.factory.config
          ? "yes — adws/adw_sssf_config/sssf.config.yaml is there"
          : "no — no roster, no queue seam, no config in this folder yet",
      },
    ];
  })();

  const buttonLabel =
    phase.kind === "running"
      ? `Running ${phase.step}…`
      : phase.kind === "ready" && !phase.readiness.git.is_repo
        ? "Initialize git, then the factory"
        : phase.kind === "failed"
          ? "Try again"
          : "Initialize factory";

  const streamed = phase.kind === "running" ? phase.lines : phase.kind === "failed" ? phase.lines : [];
  const alreadyDone = phase.kind === "done" || (phase.kind === "ready" && phase.readiness.factory.config);

  return (
    <div className="init-factory">
      <div className="if-head">
        <span className="if-title">Initialize {projectName}</span>
        <span className="if-sub">
          Two commands and no others: <code>git init</code> when the folder is not a repo yet, then{" "}
          <code>uv run .claude/skills/sssf/scripts/install.py</code> in it. Both print into the strip below as they run.
        </span>
      </div>

      <div className="detect-rows">
        {rows.map((row) => (
          <div className="detect-line" key={row.label}>
            <Dot tone={row.tone} pulse={row.tone === "run"} />
            <span className="dl-label">{row.label}</span>
            <span className="dl-sentence">{row.sentence}</span>
          </div>
        ))}
      </div>

      {streamed.length > 0 ? (
        <div className="if-log" role="log" aria-live="polite" aria-label="installer output">
          {phase.kind === "running" && phase.dropped > 0 ? (
            <div className="if-line dropped">— log truncated, {phase.dropped} earlier lines dropped —</div>
          ) : null}
          {lastLines(streamed, VISIBLE_LINES).map((line, index) => (
            <div className="if-line" key={`${index}-${line}`}>
              {line || " "}
            </div>
          ))}
        </div>
      ) : null}

      {phase.kind === "failed" ? (
        <div className="if-alert fail" role="alert">
          <span className="dot fail" aria-hidden="true" />
          <span className="if-alert-text">{phase.error}</span>
        </div>
      ) : null}

      {phase.kind === "unreadable" ? (
        <div className="if-alert fail" role="alert">
          <span className="dot fail" aria-hidden="true" />
          <span className="if-alert-text">{phase.error}</span>
        </div>
      ) : null}

      {phase.kind === "done" ? (
        <div className="if-alert ok" role="status">
          <span className="dot ok" aria-hidden="true" />
          <span className="if-alert-text">
            The factory is in this folder now — the roster, the queue seam and the config are on disk. Settings · Roster
            can edit the roster, and the Board reads the queue.
          </span>
        </div>
      ) : null}

      <div className="if-actions">
        {alreadyDone ? null : (
          <button
            type="button"
            className="ob-primary"
            disabled={phase.kind === "running" || phase.kind === "reading"}
            onClick={() => void initialize()}
          >
            {buttonLabel}
          </button>
        )}
        {phase.kind === "unreadable" ? (
          <button type="button" className="ob-secondary" onClick={reread}>
            Read the folder again
          </button>
        ) : null}
      </div>
    </div>
  );
}
