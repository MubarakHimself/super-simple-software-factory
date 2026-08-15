/**
 * The empty state, one component so the budget is one rule:
 * **heading (<= 3 words) + one sentence + at most one action.**
 *
 * The sentence is the directive: it says what the operator (or the factory)
 * has to do for data to exist here. "No data yet" on its own is a dead end;
 * "No data yet - publish a batch and the cards land here" is a door.
 *
 * The budget is checked in dev and the violation is printed, because text
 * density is a requirement, not a preference: too much text makes a real
 * surface look like mock data. Nothing is truncated at runtime - a builder who
 * blows the budget should see it, not have it hidden.
 */
import type { ReactNode } from "react";

export interface EmptyAction {
  label: string;
  onClick: () => void;
}

export function EmptyState({
  heading,
  sentence,
  action,
  note,
  children,
}: {
  heading: string;
  /** One sentence, and only when it says something the heading cannot. */
  sentence?: string;
  action?: EmptyAction;
  /** A mono aside for a truth about the app itself (e.g. a surface that is
   * still being built). Never used for data. */
  note?: string;
  children?: ReactNode;
}) {
  if (import.meta.env.DEV && heading.trim().split(/\s+/).length > 3) {
    console.warn(`[ui3] empty-state heading over budget (3 words): "${heading}"`);
  }
  return (
    <div className="empty-state fade-in">
      <h1>{heading}</h1>
      {sentence ? <p>{sentence}</p> : null}
      {action ? (
        <button type="button" className="es-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
      {note ? <p className="es-note">{note}</p> : null}
      {children}
    </div>
  );
}

/**
 * A read that failed, rendered where it happened - an inline line, never a
 * banner and never a toast. The server's own error string, verbatim.
 */
export function ReadFailure({ error }: { error: string }) {
  return (
    <p className="read-failure">
      <span>read failed</span>
      <span className="rf-error">{error}</span>
    </p>
  );
}
