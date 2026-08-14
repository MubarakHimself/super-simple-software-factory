/**
 * The empty state, one component so the budget is one rule (spec 3.6):
 * "heading <= 3 words + at most one action + at most one sentence."
 *
 * The budget is checked in dev and the violation is printed, because the
 * operator's own note is that text density is a requirement, not a preference
 * ("too much text makes it look like mock data"). Nothing is truncated at
 * runtime - a builder who blows the budget should see it, not have it hidden.
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
  children,
}: {
  heading: string;
  /** At most one, and only when it says something the heading cannot. */
  sentence?: string;
  action?: EmptyAction;
  /** For an empty state that needs an input rather than a button. */
  children?: ReactNode;
}) {
  if (import.meta.env.DEV && heading.trim().split(/\s+/).length > 3) {
    console.warn(`[ui2] empty-state heading over budget (3 words): "${heading}"`);
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <h1 className="text-hero font-semibold text-t1">{heading}</h1>
      {sentence ? <p className="max-w-[52ch] text-center text-body text-t2">{sentence}</p> : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="h-7 rounded-control border border-hairline bg-raised px-3 text-body text-t1 hover:border-accent hover:text-accent"
        >
          {action.label}
        </button>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The one "there is no factory in this project" answer (spec 2.5's empty-state
 * table), as a component so the app cannot grow three spellings of it again -
 * which is exactly the F9 defect (three names, three casings) that spec 2.0
 * was written to kill.
 *
 * The sentence is spec 2.5's string verbatim, in its own casing; the heading is
 * the surface's noun spelled the way the sidebar, the breadcrumb and the
 * surface heading spell it (spec 2.0). The `Initialize factory` action that
 * fixes this state is the top bar's (spec 2.9) - printing a second copy of one
 * button is not what "at most one action" means.
 */
export const NO_FACTORY_LINE = "no factory here";

export function NoFactory({ surface }: { surface: string }) {
  return <EmptyState heading={surface} sentence={NO_FACTORY_LINE} />;
}

/**
 * A read that failed. Spec 2.1: "the panel keeps its last good data and shows
 * `read failed - <the server's own error string>`" - an inline line at the
 * position it happened, never a banner and never a toast (spec 3.6).
 */
export function ReadFailure({ error }: { error: string }) {
  return (
    <p className="flex items-baseline gap-2 px-3 py-1 text-meta text-t3">
      <span>read failed</span>
      <span className="font-mono text-mono text-fail">{error}</span>
    </p>
  );
}
