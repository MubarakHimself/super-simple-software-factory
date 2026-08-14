/**
 * The zero-project state (spec 2.1) and the add-a-project screen.
 *
 * On first open with an empty manifest the whole app is five words:
 * heading `Add a project` + one button `Choose folder`. Nothing else renders -
 * no sidebar, no top bar, no explanation of what a project is.
 *
 * There is no native folder picker in a web app (W1-B7), so `Choose folder`
 * reveals one input that takes a typed or pasted absolute path with live
 * validation (spec 2.1, decision 4). "Live" is honest about what each side
 * can know: on every keystroke the client re-checks the one thing a browser
 * can know (the path is absolute) and re-checks the path against the server
 * verdicts already collected in this dialog, and `Add` is enabled only when
 * both pass. Existence is the server's answer - `no such directory: C:\nope`,
 * printed verbatim - and once a path has come back rejected, `Add` stays
 * disabled for that exact path until the operator edits it. Editing the field
 * therefore clears the error with the path that earned it: a stale error can
 * never sit next to a path the server has not judged.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiFailure, apiPost, type Project } from "../lib/api.ts";
import { EmptyState } from "./EmptyState.tsx";

const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/]|~[\\/]?$|~[\\/])/;

export function AddProject({ onAdded }: { onAdded: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  // Server verdicts keyed by the exact path that earned them, so an edit both
  // clears the message and re-enables Add, and typing the bad path back in
  // disables it again without a second round trip.
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const trimmed = path.trim();
  const shapeError = trimmed === "" || ABSOLUTE.test(trimmed) ? null : "absolute path required";
  const serverError = rejected[trimmed] ?? null;
  const ready = trimmed !== "" && !shapeError && !serverError;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const project = await apiPost<Project>("/api/app/projects", { path: trimmed });
      onAdded();
      navigate(`/p/${project.id}/home`);
    } catch (failure) {
      const message = failure instanceof ApiFailure ? failure.message : (failure as Error).message;
      setRejected((previous) => ({ ...previous, [trimmed]: message }));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <EmptyState heading="Add a project" action={{ label: "Choose folder", onClick: () => setOpen(true) }} />;
  }

  return (
    <EmptyState heading="Add a project">
      <div className="flex w-[520px] max-w-[86vw] flex-col gap-2">
        <input
          autoFocus
          value={path}
          spellCheck={false}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          className="h-8 w-full rounded-control border border-hairline bg-raised px-2 font-mono text-mono text-t1 outline-none focus:border-accent"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => void submit()}
            className="h-7 rounded-control border border-hairline bg-raised px-3 text-body text-t1 disabled:cursor-default disabled:text-t3 enabled:hover:border-accent enabled:hover:text-accent"
          >
            Add
          </button>
          {serverError ? (
            <span className="flex items-baseline gap-2 text-meta text-t3">
              <span>add failed</span>
              <span className="font-mono text-mono text-fail">{serverError}</span>
            </span>
          ) : shapeError ? (
            <span className="font-mono text-mono text-t3">{shapeError}</span>
          ) : null}
        </div>
      </div>
    </EmptyState>
  );
}
