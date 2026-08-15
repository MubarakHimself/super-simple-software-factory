/**
 * Add project — the shell's minimum: one repo path, one POST, the server's own
 * answer if it refuses.
 *
 * `POST /api/app/projects` takes `{ path }` and nothing else; the name comes
 * from the folder. So this form asks for the path and says where the name
 * comes from, rather than drawing a Name field whose value would be silently
 * discarded.
 *
 * The full add-project journey the settings mock draws — live Git / Factory
 * detection rows, sync mode, roster inheritance — belongs to the Settings
 * chunk and to the endpoints behind it. It replaces this modal's BODY; the
 * trigger (the switcher's "Add project…") and the mount stay here.
 */
import { useState } from "react";
import { apiPost, type Project } from "../lib/api.ts";

export function AddProject({
  onAdded,
  onCancel,
}: {
  onAdded: (project: Project) => void;
  /** Absent when this is the app's first-run surface: there is nowhere to go back to. */
  onCancel?: () => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await apiPost<Project>("/api/app/projects", { path: trimmed });
      onAdded(project);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (onCancel && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal fade-in" role="dialog" aria-modal="true" aria-label="Add project">
        <div className="modal-header">
          <h3>Add project</h3>
          <div className="modal-sub">Register a repository so the factory can run work on it.</div>
        </div>
        <div className="modal-body">
          <div className="modal-field">
            <label htmlFor="add-project-path">Repo path</label>
            <input
              id="add-project-path"
              type="text"
              placeholder="C:\path\to\repo"
              value={path}
              spellCheck={false}
              autoFocus
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            <span className="field-hint">The project takes its name from the folder.</span>
          </div>
          {error ? <div className="modal-error">{error}</div> : null}
        </div>
        <div className="modal-footer">
          {onCancel ? (
            <button type="button" className="modal-btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="button" className="modal-btn primary" onClick={() => void submit()} disabled={busy || !path.trim()}>
            {busy ? "Adding…" : "Add project"}
          </button>
        </div>
      </div>
    </div>
  );
}
