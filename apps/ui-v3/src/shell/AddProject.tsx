/**
 * Add project — the one journey, reached from the switcher, from Settings'
 * scope list, and from the first-run surface (J2).
 *
 * ── What was broken, and what each part fixes ──────────────────────────────
 *  · There was no way to point at a folder: the modal drew a text field and
 *    the operator had to type a Windows path by hand. **Browse…** opens the
 *    OS directory dialog through the desktop bridge
 *    (`window.factory.pickFolder()`); in a browser the button is not drawn at
 *    all and the sentence under the field says why. The manual field always
 *    works, in both.
 *  · Detection used to REGISTER the path before it could read it (readiness is
 *    keyed by a registered project id), so every mistyped-but-real directory
 *    became a permanent project. Detection now runs
 *    `POST /api/app/projects {intent:"probe"}`, which writes nothing —
 *    the rows are a report about a folder, not a side effect on the list.
 *  · Add is the only write, and it is one: `{intent:"add"}` upserts by
 *    normalized path, so adding a path twice opens the project instead of
 *    duplicating it — the row says that before the click.
 *
 * ── What this modal deliberately does NOT do ───────────────────────────────
 * It does not run `git init` and it does not run the factory installer. Both
 * are real endpoints, but a folder that is not a repo and has no factory is a
 * valid project to register — the detection rows state exactly what is
 * missing, and initialization belongs to the surface that can show the job's
 * own output. Nothing here is silent, and nothing here pretends.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPost, type Project } from "../lib/api.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { canPickFolder, pickFolder } from "./desktop.ts";
import "./onboarding.css";

/** `POST /api/app/projects {intent:"probe"}` — see `server/app/manifest.ts`'s
 * `PathProbe`. Every field is a fact read off the disk. */
interface PathProbe {
  path: string;
  name: string;
  exists: boolean;
  is_directory: boolean;
  is_git_repo: boolean;
  git_branch: string | null;
  factory_initialized: boolean;
  registered_id: string | null;
  problem: string | null;
}

type ProbeState =
  | { kind: "empty" }
  | { kind: "probing" }
  | { kind: "done"; probe: PathProbe }
  | { kind: "failed"; error: string };

const PROBE_DEBOUNCE_MS = 400;

interface Row {
  tone: Tone;
  label: string;
  sentence: string;
}

/** The three rows, each a dot + a bold label + one plain sentence. A row never
 * shows a state it has not read: before a probe lands it says so. */
function rows(state: ProbeState, typed: boolean): Row[] {
  if (state.kind === "empty") {
    const sentence = typed ? "reading the folder…" : "nothing to read yet — choose or type a path";
    return [
      { tone: "idle", label: "Folder", sentence },
      { tone: "idle", label: "Git repository", sentence },
      { tone: "idle", label: "Factory initialized", sentence },
    ];
  }
  if (state.kind === "probing") {
    return [
      { tone: "run", label: "Folder", sentence: "reading…" },
      { tone: "run", label: "Git repository", sentence: "reading…" },
      { tone: "run", label: "Factory initialized", sentence: "reading…" },
    ];
  }
  if (state.kind === "failed") {
    return [
      { tone: "fail", label: "Folder", sentence: state.error },
      { tone: "idle", label: "Git repository", sentence: "not read — the folder could not be read" },
      { tone: "idle", label: "Factory initialized", sentence: "not read — the folder could not be read" },
    ];
  }

  const probe = state.probe;
  if (probe.problem) {
    return [
      { tone: "fail", label: "Folder", sentence: probe.problem },
      { tone: "idle", label: "Git repository", sentence: "not read — there is no folder at that path" },
      { tone: "idle", label: "Factory initialized", sentence: "not read — there is no folder at that path" },
    ];
  }

  return [
    {
      tone: "ok",
      label: "Folder",
      sentence: probe.registered_id
        ? `already in this machine's project list — Add opens it, it is not added twice`
        : `a folder is there; the project will be called "${probe.name}"`,
    },
    {
      tone: probe.is_git_repo ? "ok" : "warn",
      label: "Git repository",
      sentence: probe.is_git_repo
        ? `yes — on branch ${probe.git_branch ?? "unknown"}`
        : "no — the factory works in a git repository, so this one has to become one before it can run work",
    },
    {
      tone: probe.factory_initialized ? "ok" : "warn",
      label: "Factory initialized",
      sentence: probe.factory_initialized
        ? "yes — adws/adw_sssf_config/sssf.config.yaml is there"
        : "no — no roster, no queue seam, no config in this folder yet",
    },
  ];
}

export function AddProject({
  onAdded,
  onCancel,
}: {
  onAdded: (project: Project) => void;
  /** Absent when this is the app's first-run surface: there is nowhere to go back to. */
  onCancel?: () => void;
}) {
  const [path, setPath] = useState("");
  const [state, setState] = useState<ProbeState>({ kind: "empty" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = canPickFolder();

  // The probe keeps running in the network after the modal closes; this stops
  // it writing into an unmounted component.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const probe = useCallback(async (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) {
      setState({ kind: "empty" });
      return;
    }
    setState({ kind: "probing" });
    try {
      const result = await apiPost<PathProbe>("/api/app/projects", { path: trimmed, intent: "probe" });
      if (!alive.current) return;
      setState({ kind: "done", probe: result });
    } catch (failure) {
      if (!alive.current) return;
      setState({ kind: "failed", error: (failure as Error).message });
    }
  }, []);

  // Typing settles, then the rows read. Not on every keystroke: half a path is
  // not a question worth asking the disk.
  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) {
      setState({ kind: "empty" });
      return;
    }
    const timer = window.setTimeout(() => void probe(trimmed), PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [path, probe]);

  const browse = async () => {
    setError(null);
    try {
      const pick = await pickFolder();
      if (!alive.current || pick.canceled || !pick.path) return;
      setPath(pick.path);
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    }
  };

  const trimmed = path.trim();
  const blocked = state.kind === "done" ? state.probe.problem : null;
  const canAdd = Boolean(trimmed) && !busy && !blocked && state.kind !== "failed";

  const submit = async () => {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      const project = await apiPost<Project>("/api/app/projects", { path: trimmed, intent: "add" });
      onAdded(project);
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (onCancel && !busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal fade-in" role="dialog" aria-modal="true" aria-label="Add project">
        <div className="modal-header">
          <h3>Add project</h3>
          <div className="modal-sub">Register a repository so the factory can run work on it.</div>
        </div>
        <div className="modal-body">
          <div className="modal-field">
            <label htmlFor="add-project-path">Repo folder</label>
            <div className="path-picker">
              <input
                id="add-project-path"
                type="text"
                placeholder="C:\path\to\repo"
                value={path}
                spellCheck={false}
                autoFocus
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              {desktop ? (
                <button type="button" className="modal-btn" disabled={busy} onClick={() => void browse()}>
                  Browse…
                </button>
              ) : null}
            </div>
            <span className="field-hint">
              {desktop
                ? "The project takes its name from the folder. Nothing is written inside it."
                : "Type or paste the path — the folder picker is native, so it only exists in the desktop app. The project takes its name from the folder, and nothing is written inside it."}
            </span>
          </div>

          <div className="modal-field">
            <label>Detection</label>
            <div className="detect-rows">
              {rows(state, Boolean(trimmed)).map((row) => (
                <div className="detect-line" key={row.label}>
                  <Dot tone={row.tone} pulse={row.tone === "run"} />
                  <span className="dl-label">{row.label}</span>
                  <span className="dl-sentence">{row.sentence}</span>
                </div>
              ))}
            </div>
            <span className="field-hint">Read from the folder itself. Detection registers nothing.</span>
          </div>

          {error ? <div className="modal-error">{error}</div> : null}
        </div>
        <div className="modal-footer">
          {onCancel ? (
            <button type="button" className="modal-btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button type="button" className="modal-btn primary" onClick={() => void submit()} disabled={!canAdd}>
            {busy ? "Adding…" : state.kind === "done" && state.probe.registered_id ? "Open project" : "Add project"}
          </button>
        </div>
      </div>
    </div>
  );
}
