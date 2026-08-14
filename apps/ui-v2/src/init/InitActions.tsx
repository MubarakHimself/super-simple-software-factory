/**
 * The contextual top-bar actions (spec 2.9, W1-E1, W3-D1/D3):
 *
 *   "computed from `/readiness`, rendered only when actionable, vanishing
 *    when satisfied. On a fully-initialized project **neither renders** and
 *    the slot is empty."
 *
 * So there is no disabled state, no "already initialized" chip and no
 * explanatory sentence anywhere in this file - the presence of the button IS
 * the statement, exactly the `t3-initialize-git-state.png` model.
 *
 *   Initialize Git      when `!git.is_repo` - one button, no dialog, no
 *                       confirmation copy: the state change is the feedback.
 *   Initialize factory  when `git.is_repo && !factory.config` - a small panel
 *                       of paths, not prose, and one `Initialize` button.
 *
 * The job strip stays after the action disappears. That is deliberate: the
 * button vanishes on the next readiness poll (2-10s after exit 0), and a log
 * that vanished with it would take the installer's own output with it. The
 * strip closes when the operator closes it.
 *
 * **Density bootstrap.** This component is the one thing this chunk owns that
 * the shell mounts on every route (TopBar renders it always, and it returns
 * null when nothing is actionable), so the Appearance pane's density class is
 * applied from here - see the note at the top of `settings/density.ts`. A
 * preference applied only inside the lazily-loaded Settings chunk would miss
 * every route the operator did not visit Settings from.
 */
import { useCallback, useState } from "react";
import { useShell } from "../App.tsx";
import { apiPost } from "../lib/api.ts";
import { useResource } from "../lib/poll.ts";
import { StatusTriple } from "../shared/StatusTriple.tsx";
import "../settings/density.ts";
import { JobStrip } from "./JobStrip.tsx";

/** What `uv run .../sssf/scripts/install.py` puts in a project. Paths, not
 * prose - the panel says what will exist, and nothing about why. */
const FACTORY_PATHS = ["adws/", "sssf.config.yaml", "justfile", ".env.sample"];

interface RunningJob {
  id: string;
  kind: "git" | "factory";
}

const JOB_TITLE: Record<RunningJob["kind"], string> = {
  git: "git init",
  factory: "Factory install",
};

function ActionButton({
  label,
  onClick,
  busy,
  expanded,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-expanded={expanded}
      className="h-6 rounded-control border border-hairline bg-raised px-2 text-body text-t2 hover:border-accent hover:text-accent disabled:text-t3"
    >
      {label}
    </button>
  );
}

export default function InitActions() {
  const { projectId, readiness } = useShell();
  const [job, setJob] = useState<RunningJob | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [finished, setFinished] = useState<number | null>(null);

  const state = readiness.data;
  const needsGit = state !== null && !state.git.is_repo;
  const needsFactory = state !== null && state.git.is_repo && !state.factory.config;

  const start = useCallback(
    async (kind: RunningJob["kind"]) => {
      setBusy(true);
      setFailure(null);
      setFinished(null);
      try {
        const { job_id } = await apiPost<{ job_id: string }>(
          `/api/app/p/${encodeURIComponent(projectId)}/init/${kind}`,
        );
        setPanelOpen(false);
        setJob({ id: job_id, kind });
      } catch (error) {
        // The server's own sentence, verbatim - for `init/factory` that
        // sentence names both paths it looked for the install script at,
        // which is spec 2.9's "the missing path" said by the only component
        // that actually knows it.
        setFailure((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const onFinished = useCallback(
    (exitCode: number | null) => {
      setFinished(exitCode);
      readiness.refresh();
    },
    [readiness],
  );

  if (!needsGit && !needsFactory && !job && !failure) return null;

  return (
    <div className="relative flex items-center gap-2">
      {needsGit ? <ActionButton label="Initialize Git" busy={busy} onClick={() => void start("git")} /> : null}
      {needsFactory ? (
        <ActionButton
          label="Initialize factory"
          expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        />
      ) : null}

      {(panelOpen && needsFactory) || job || failure ? (
        <div className="absolute right-0 top-full z-30 mt-1 flex flex-col items-end gap-2">
          {panelOpen && needsFactory ? (
            <div className="w-[260px] rounded-control border border-hairline bg-overlay p-2 shadow-[var(--shadow-overlay)]">
              <ul className="font-mono text-mono text-t2">
                {FACTORY_PATHS.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => void start("factory")}
                className="mt-2 h-6 w-full rounded-control border border-hairline bg-raised text-body text-t1 hover:border-accent hover:text-accent disabled:text-t3"
              >
                Initialize
              </button>
            </div>
          ) : null}

          {failure ? (
            <p className="flex max-w-[560px] items-baseline gap-2 rounded-control border border-hairline bg-overlay px-2 py-1 text-meta text-t3 shadow-[var(--shadow-overlay)]">
              <span className="shrink-0">failed</span>
              <span className="min-w-0 font-mono text-mono text-fail">{failure}</span>
            </p>
          ) : null}

          {job ? (
            <div className="flex flex-col items-stretch gap-2">
              <JobStrip
                jobId={job.id}
                title={JOB_TITLE[job.kind]}
                onFinished={onFinished}
                onClose={() => {
                  setJob(null);
                  setFinished(null);
                }}
              />
              {job.kind === "factory" && finished === 0 ? <PostInstall /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The post-install checklist (spec 2.9): "three live probes, not prose -
 * `.env` **exists** (a `stat`, and the file is **never opened**); `pi` on
 * PATH; `runs`."
 *
 * `.env` presence comes from `/api/app/files`, a directory walk that returns
 * paths and never file contents - so the app still never opens `.env`, which
 * is `specs/ui.md`:367's rule and spec 2.8's restatement of it. The match is
 * exact on the path, so `.env.sample` (which the installer also writes) can
 * never be mistaken for `.env`.
 */
function PostInstall() {
  const { projectId, readiness } = useShell();
  const files = useResource<{ path: string; name: string }[]>(
    `${projectId}|env-probe`,
    `/api/app/files?project=${encodeURIComponent(projectId)}&q=.env&limit=200`,
  );
  const envExists = (files.data ?? []).some((entry) => entry.path === ".env");
  const pi = readiness.data?.harnesses.pi ?? null;
  const runs = readiness.data?.runs.count ?? null;

  return (
    <div className="flex w-[560px] flex-col gap-1 rounded-control border border-hairline bg-overlay p-2 shadow-[var(--shadow-overlay)]">
      {files.data ? (
        <StatusTriple
          tone={envExists ? "ok" : "neutral"}
          identifier=".env"
          sentence={envExists ? "exists" : "not written yet"}
        />
      ) : null}
      {pi ? (
        <StatusTriple
          tone={pi.state === "ready" ? "ok" : "neutral"}
          identifier="pi"
          sentence={pi.state === "ready" ? "on PATH" : "not on PATH"}
        />
      ) : null}
      {runs !== null ? (
        <StatusTriple tone={runs > 0 ? "ok" : "neutral"} identifier="runs" sentence={`${runs} recorded`} />
      ) : null}
    </div>
  );
}
