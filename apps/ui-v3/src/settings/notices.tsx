/**
 * The two shapes that replaced the paragraphs on these panes.
 *
 * The operator's ruling on the first draft: *"There is TOO MUCH TEXT. No human
 * in the world is going to read this... I would rather, if I make a mistake,
 * the UI corrects me — like an alert."* So guidance moved to the moment it is
 * needed, and the standing explanations moved behind a word-link:
 *
 *   <Alert>          the app correcting the operator — a write that failed, an
 *                    input that cannot be accepted, a config that says one
 *                    thing while the engine does another. One plain sentence:
 *                    what happened, then the fix. Dismissable, never permanent.
 *
 *   <HowThisWorks>   the mechanism truths that are true but not urgent (where a
 *                    key is written, what a sync sends, what a deploy runs)
 *                    behind one small link, closed every time the pane opens.
 *
 * Nothing here renders below `--text-meta` (12px). A hint that would have to be
 * smaller than that to fit is a hint that should not exist.
 */
import type { ReactNode } from "react";

export type AlertKind = "fail" | "warn" | "ok";

export function Alert({
  kind = "fail",
  children,
  onDismiss,
}: {
  kind?: AlertKind;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`pane-alert ${kind}`} role="alert">
      <span className="pa-dot" />
      <span className="pa-text">{children}</span>
      {onDismiss ? (
        <button type="button" className="pa-close" onClick={onDismiss} aria-label="Dismiss this message">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function HowThisWorks({ label = "How this works", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="how-works">
      <summary>{label}</summary>
      <div className="hw-body">{children}</div>
    </details>
  );
}
