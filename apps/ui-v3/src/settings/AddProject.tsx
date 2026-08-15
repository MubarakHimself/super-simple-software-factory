/**
 * Add project — the modal settings-v3.html draws, wired to the endpoints that
 * exist (J2, change-list #10).
 *
 * ── What the endpoints allow, and what that means for the drawing ──────────
 * `POST /api/app/projects` takes ONE field, `{path}`, and names the project
 * after the folder; it is idempotent per path (`manifest.ts` upserts by
 * normalized root), so registering the same path twice returns the same
 * project rather than a duplicate. `GET /api/app/projects/:id/readiness` and
 * both init writes are keyed by a REGISTERED project id — there is no endpoint
 * that inspects an arbitrary path. So:
 *
 *   · The Name field is drawn and disabled, showing the folder name the server
 *     will use. A field whose value is silently discarded is worse than none.
 *   · Detection probes on a click, not on every keystroke, and the hint says
 *     what the click does first: it registers the path in THIS machine's
 *     project list (a line in `~/.sdl-factory/config.json`, nothing inside the
 *     folder), because detection reads are per registered project.
 *   · Sync mode drops "Manual" (change-list #10 — the engine always pulls) and
 *     is disabled along with roster inheritance: nothing on this machine stores
 *     either choice today, and a select that quietly forgets is a lie.
 *
 * ── Add converges, and says what it did ───────────────────────────────────
 * The app may run exactly two commands (`server/app/jobs.ts`: "exactly two
 * commands may ever create a job") — `git init` and the factory installer —
 * and both are OFFERED, never silent (J2.2). Every step lands in the step list
 * with the server's or the job's own words, including the ones that were
 * skipped and the ones this app does not do at all.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, type Project } from "../lib/api.ts";
import type { JobHandle, JobStatus, Readiness } from "./types.ts";

type Tone = "ok" | "fail" | "warn" | "run" | "neutral";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--ok)",
  fail: "var(--fail)",
  warn: "var(--warn)",
  run: "var(--run)",
  neutral: "var(--t3)",
};

interface Step {
  tone: Tone;
  text: string;
  detail?: string;
}

type Probe =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "done"; project: Project; readiness: Readiness }
  | { kind: "failed"; error: string };

const JOB_POLL_MS = 700;

/** The folder name the server will use (`manifest.ts`: `basename(root)`).
 * Computed here only to SHOW it — the server derives its own. */
function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

function lastLine(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && line.trim()) return line.trim();
  }
  return null;
}

/** A finished job, in its own words: the exit code and the last thing it
 * printed. Never a summary this app invented. */
function jobStep(job: JobStatus, what: string): Step {
  const parts: string[] = [];
  if (job.exit_code !== null) parts.push(`exit ${job.exit_code}`);
  const line = lastLine(job.lines);
  if (line) parts.push(line);
  if (job.dropped > 0) parts.push(`${job.dropped} earlier lines were dropped from the log`);
  return {
    tone: job.state === "done" ? "ok" : "fail",
    text: job.state === "done" ? `${what} finished.` : `${what} failed.`,
    detail: parts.length ? parts.join(" · ") : undefined,
  };
}

function detectionDetail(readiness: Readiness): string {
  const git = readiness.git.is_repo
    ? `git repository yes (branch ${readiness.git.branch ?? "unknown"})`
    : "git repository no";
  const factory = readiness.factory.config ? "factory config present" : "factory config absent";
  const queue = readiness.factory.queue_template ? "queue/TEMPLATE.md present" : "queue/TEMPLATE.md absent";
  const adws = readiness.factory.adws ? "adws/ present" : "adws/ absent";
  return [git, factory, queue, adws].join(" · ");
}

export function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (project: Project) => void }) {
  const [path, setPath] = useState("");
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });
  const [runGitInit, setRunGitInit] = useState(true);
  const [runFactoryInit, setRunFactoryInit] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<Project | null>(null);

  // The sequence keeps running in the network even if this modal goes away;
  // this ref is what stops it writing into an unmounted component.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const trimmed = path.trim();
  const pushStep = useCallback((step: Step) => setSteps((prev) => [...prev, step]), []);
  const settleLast = useCallback((step: Step) => setSteps((prev) => [...prev.slice(0, -1), step]), []);

  const readinessOf = (id: string) => apiGet<Readiness>(`/api/app/projects/${encodeURIComponent(id)}/readiness`);

  const waitForJob = async (jobId: string): Promise<JobStatus> => {
    for (;;) {
      const status = await apiGet<JobStatus>(`/api/app/jobs/${encodeURIComponent(jobId)}`);
      if (status.state !== "running" || !alive.current) return status;
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
  };

  const probeNow = async () => {
    if (!trimmed || probe.kind === "probing" || running) return;
    setProbe({ kind: "probing" });
    try {
      const project = await apiPost<Project>("/api/app/projects", { path: trimmed });
      const readiness = await readinessOf(project.id);
      if (!alive.current) return;
      setProbe({ kind: "done", project, readiness });
    } catch (failure) {
      if (!alive.current) return;
      setProbe({ kind: "failed", error: (failure as Error).message });
    }
  };

  const add = async () => {
    if (!trimmed || running) return;
    setRunning(true);
    setSteps([]);
    try {
      const project = await apiPost<Project>("/api/app/projects", { path: trimmed });
      pushStep({ tone: "ok", text: `Registered ${project.name} in this machine's project list.`, detail: project.root });

      let readiness = await readinessOf(project.id);
      pushStep({ tone: "neutral", text: "Read what is already in the folder.", detail: detectionDetail(readiness) });

      if (!readiness.git.is_repo) {
        if (runGitInit) {
          pushStep({ tone: "run", text: "Running git init…" });
          try {
            const handle = await apiPost<JobHandle>(`/api/app/p/${encodeURIComponent(project.id)}/init/git`, {});
            settleLast(jobStep(await waitForJob(handle.job_id), "git init"));
          } catch (failure) {
            settleLast({ tone: "fail", text: "git init was refused.", detail: (failure as Error).message });
          }
          readiness = await readinessOf(project.id);
        } else {
          pushStep({
            tone: "warn",
            text: "Skipped git init — the switch is off.",
            detail: "The factory works in a git repository, so nothing below can run until this folder is one.",
          });
        }
      } else {
        pushStep({
          tone: "ok",
          text: "Already a git repository — nothing to initialize.",
          detail: `branch ${readiness.git.branch ?? "unknown"}${readiness.git.remote ? ` · remote ${readiness.git.remote}` : " · no origin remote"}`,
        });
      }

      if (readiness.factory.config) {
        pushStep({
          tone: "ok",
          text: "The factory is already initialized here.",
          detail: "adws/adw_sssf_config/sssf.config.yaml is present, so the installer was not run.",
        });
      } else if (!readiness.git.is_repo) {
        pushStep({
          tone: "warn",
          text: "The factory installer was not run.",
          detail: "It refuses on a folder that is not a git repository yet — that is the server's own guard, not this app's.",
        });
      } else if (!runFactoryInit) {
        pushStep({
          tone: "warn",
          text: "Skipped the factory installer — the switch is off.",
          detail: "Without it there is no roster, no queue seam and no config for this project.",
        });
      } else {
        pushStep({ tone: "run", text: "Running the factory installer…" });
        try {
          const handle = await apiPost<JobHandle>(`/api/app/p/${encodeURIComponent(project.id)}/init/factory`, {});
          settleLast(jobStep(await waitForJob(handle.job_id), "the factory installer"));
        } catch (failure) {
          settleLast({ tone: "fail", text: "The factory installer did not start.", detail: (failure as Error).message });
        }
        readiness = await readinessOf(project.id);
      }

      if (!alive.current) return;
      setProbe({ kind: "done", project, readiness });
      pushStep({
        tone: readiness.git.is_repo && readiness.factory.config ? "ok" : "warn",
        text: "Where the project stands now.",
        detail: detectionDetail(readiness),
      });
      pushStep({
        tone: "neutral",
        text: "Sync mode and roster inheritance were not applied.",
        detail:
          "Neither has anywhere to be stored on this machine yet: the engine always pulls, and the roster is written by the installer. Both selects are drawn and disabled for that reason.",
      });
      pushStep({
        tone: "neutral",
        text: "This app ran two commands and no others.",
        detail:
          "git init and the factory installer. The integration branch, the engine's registration on a server and any provider credential belong to the factory machine's connection, which is not part of this build.",
      });
      setFinished(project);
    } catch (failure) {
      if (alive.current) pushStep({ tone: "fail", text: "The project was not registered.", detail: (failure as Error).message });
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  /* ── the two detection rows ─────────────────────────────────────────────── */

  const gitRow: { tone: Tone; state: string } = (() => {
    if (probe.kind === "probing") return { tone: "run", state: "probing…" };
    if (probe.kind === "failed") return { tone: "fail", state: "— probe failed" };
    if (probe.kind === "done") {
      return probe.readiness.git.is_repo
        ? { tone: "ok", state: `yes · branch ${probe.readiness.git.branch ?? "unknown"}` }
        : { tone: "warn", state: "no — not a git repository" };
    }
    return { tone: "neutral", state: trimmed ? "— not probed yet" : "— enter path" };
  })();

  const factoryRow: { tone: Tone; state: string } = (() => {
    if (probe.kind === "probing") return { tone: "run", state: "probing…" };
    if (probe.kind === "failed") return { tone: "fail", state: "— probe failed" };
    if (probe.kind === "done") {
      return probe.readiness.factory.config
        ? { tone: "ok", state: "initialized" }
        : { tone: "warn", state: "not initialized" };
    }
    return { tone: "neutral", state: trimmed ? "— not probed yet" : "— enter path" };
  })();

  const detectHint =
    probe.kind === "done"
      ? `Read from ${probe.project.root}. Add runs only what is missing.`
      : "Probing registers this path in this machine's project list first — detection reads run per registered project — then reports what is in the folder. It writes nothing inside the folder itself.";

  const name = folderName(path);

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (!running && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal add-project fade-in" role="dialog" aria-modal="true" aria-label="Add project">
        <div className="modal-header">
          <h3>Add project</h3>
          <div className="modal-sub">Register a repository so the factory can run work on it.</div>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <label htmlFor="add-name">Project name</label>
            <input id="add-name" type="text" value={name} placeholder="— from the folder" disabled readOnly />
            <span className="field-hint">
              Taken from the folder name — this app has no rename write, so the field shows what the server will use
              rather than asking for a name it would discard.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="add-path">Repository path</label>
            <input
              id="add-path"
              type="text"
              placeholder="C:\path\to\repo"
              value={path}
              spellCheck={false}
              autoFocus
              disabled={running}
              onChange={(event) => {
                setPath(event.target.value);
                setProbe({ kind: "idle" });
              }}
            />
            <span className="field-hint">Local path to the git repo the factory will work in.</span>
          </div>

          <div className="modal-field">
            <label>Detection</label>
            <div className="modal-detection">
              <span className="detect-row">
                <span className="detect-dot" style={{ background: TONE_COLOR[gitRow.tone] }} /> Git repository
                <span className="detect-state">{gitRow.state}</span>
              </span>
              <span className="detect-row">
                <span className="detect-dot" style={{ background: TONE_COLOR[factoryRow.tone] }} /> Factory initialized
                <span className="detect-state">{factoryRow.state}</span>
              </span>
              <span className="detect-hint">{detectHint}</span>
            </div>
            {probe.kind === "failed" ? <span className="modal-error">{probe.error}</span> : null}
            <div className="modal-choice">
              <button
                type="button"
                className="pr-btn"
                disabled={!trimmed || probe.kind === "probing" || running}
                onClick={() => void probeNow()}
              >
                {probe.kind === "probing" ? "Probing…" : "Probe this path"}
              </button>
            </div>
          </div>

          <div className="modal-choice">
            <div className="form-label-group">
              <div className="form-label">Run git init if this folder is not a repo</div>
              <div className="form-hint">Offered, never silent — Add runs it only when detection found no repository.</div>
            </div>
            <button
              type="button"
              className={`form-toggle${runGitInit ? " on" : ""}`}
              aria-label={`run git init ${runGitInit ? "on" : "off"}`}
              disabled={running}
              onClick={() => setRunGitInit((on) => !on)}
            />
          </div>

          <div className="modal-choice">
            <div className="form-label-group">
              <div className="form-label">Run the factory installer if it is missing</div>
              <div className="form-hint">
                <code>uv run .claude/skills/sssf/scripts/install.py</code> in the folder — the frozen installer, never
                edited by this app.
              </div>
            </div>
            <button
              type="button"
              className={`form-toggle${runFactoryInit ? " on" : ""}`}
              aria-label={`run the factory installer ${runFactoryInit ? "on" : "off"}`}
              disabled={running}
              onClick={() => setRunFactoryInit((on) => !on)}
            />
          </div>

          <div className="modal-field">
            <label htmlFor="add-sync">Sync mode</label>
            <select id="add-sync" disabled defaultValue="boot">
              <option value="boot">Pull on boot — the factory pulls latest main at start</option>
              <option value="watch">Watch — the factory pulls when main moves</option>
            </select>
            <span className="field-hint">
              The engine always pulls, so these are cadence labels, not a switch — and there is nowhere on this machine
              to store the choice yet. &ldquo;Manual&rdquo; is gone: it is not how the factory works.
            </span>
          </div>

          <div className="modal-field">
            <label htmlFor="add-roster">Inherit roster from</label>
            <select id="add-roster" disabled defaultValue="defaults">
              <option value="defaults">Factory defaults — the installer&apos;s own roster</option>
              <option value="copy">Copy from existing project…</option>
              <option value="empty">Start empty — I&apos;ll configure agents</option>
            </select>
            <span className="field-hint">
              The installer writes this project&apos;s roster into its own config file. Copying one from another project
              is a write this app does not make yet, so the choice is drawn and disabled.
            </span>
          </div>

          {steps.length > 0 ? (
            <div className="modal-field">
              <label>What happened</label>
              <div className="modal-steps">
                {steps.map((step, index) => (
                  <div className="step-row" key={`${index}-${step.text}`}>
                    <span
                      className={`step-dot${step.tone === "run" ? " pulse" : ""}`}
                      style={{ background: TONE_COLOR[step.tone] }}
                    />
                    <span className="step-text">
                      {step.text}
                      {step.detail ? <span className="step-detail">{step.detail}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose} disabled={running}>
            {finished ? "Close" : "Cancel"}
          </button>
          {finished ? (
            <button type="button" className="modal-btn primary" onClick={() => onAdded(finished)}>
              Open {finished.name}
            </button>
          ) : (
            <button type="button" className="modal-btn primary" onClick={() => void add()} disabled={running || !trimmed}>
              {running ? "Working…" : "Add project"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
