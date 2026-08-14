/**
 * The four shapes every Settings pane is built out of, stated once so the
 * five panes cannot drift into five idioms (spec 3.6's "shared kit" rule
 * applied inside one surface).
 *
 *   Pane      - heading + body, one scroll container
 *   Section   - a sentence-case label above a group; no paragraph under it
 *   Field     - `label ......... value`, one line, one fact
 *   Segmented - the only control this surface has (theme, density)
 *
 * Two rules from spec 2.8 are enforced by these components existing rather
 * than by asking each pane to remember them:
 *   - **No description line under a control.** `Segmented` has no slot for
 *     one. "That is precisely what makes T3's settings text-heavy."
 *   - **Absent when null.** `Field` returns null for a null/empty value, so a
 *     pane can hand it `readiness.git.remote` without an `&&` and a fact the
 *     record does not carry simply does not draw a row - never an em-dash
 *     placeholder.
 *
 * Sentence case everywhere, no ALL-CAPS anywhere (spec 2.0's casing rule -
 * the "eyebrow" idiom is deleted along with `SESSIONS`).
 */
import type { ReactNode } from "react";

export function Pane({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <h1 className="mb-5 text-head font-semibold text-t1">{heading}</h1>
      {/* The 760px cap was the whole of the operator's Settings complaint: a
          pane a metre wide, with its right two thirds empty. The cap is now the
          width past which a `label ... value` row stops being readable, not a
          column drawn down the middle of the screen. */}
      <div className="max-w-[1600px]">{children}</div>
    </div>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-8 break-inside-avoid">
      <h2 className="mb-2 text-meta text-t3">{label}</h2>
      {children}
    </section>
  );
}

/**
 * Sections side by side rather than stacked down a narrow column: as many
 * ~560px columns as the pane can hold, and one column when it cannot hold two.
 * A pane with four short sections fills a wide window with its own facts
 * instead of leaving them for a scrollbar to reveal.
 *
 * 560 is not a taste number: it is the width at which `Root` and `Db` print
 * their whole absolute path instead of an ellipsis. A layout that fills the
 * window by cutting the facts in half would be the same defect wearing the
 * opposite sign.
 */
export function SectionColumns({ children }: { children: ReactNode }) {
  return <div className="[column-gap:64px] columns-[560px]">{children}</div>;
}

/**
 * One fact. `value` may be a string (rendered mono, because everything a
 * machine wrote is mono - spec 3.3) or arbitrary nodes when the pane needs a
 * chip beside it.
 */
export function Field({
  label,
  value,
  title,
  children,
}: {
  label: string;
  value?: string | number | null;
  title?: string;
  children?: ReactNode;
}) {
  const hasValue = value !== null && value !== undefined && String(value).length > 0;
  if (!hasValue && !children) return null;
  return (
    <div className="flex items-baseline gap-4 border-t border-hairline py-1.5 text-body first:border-t-0">
      {/* 120px, not 150: the longest label here is `Sessions dir`, and the 30px
          the wider column was spending on nothing were the 30px by which this
          project's `Db` path missed fitting inside a 560px section column and
          got ellipsised. A layout that fills the window by cutting the facts in
          half is the same defect wearing the opposite sign. */}
      <span className="w-[120px] shrink-0 text-t2">{label}</span>
      {hasValue ? (
        <span className="min-w-0 flex-1 truncate font-mono text-mono text-t1" title={title ?? String(value)}>
          {value}
        </span>
      ) : null}
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

/** Bare labels, and no room for anything else (spec 2.8 Appearance). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-control border border-hairline bg-raised"
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.id)}
            className={[
              "h-7 border-l border-hairline px-4 text-body first:border-l-0",
              on ? "bg-accent-surface text-t1" : "text-t2 hover:bg-row-hover hover:text-t1",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A machine string the operator will want to paste. One line, mono, and a
 * copy affordance rather than a second sentence explaining it. */
export function CopyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-control border border-hairline bg-raised px-2 py-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-mono text-t1">{text}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(text)}
        className="shrink-0 rounded-chip px-1.5 text-meta text-t3 hover:bg-row-hover hover:text-t1"
      >
        Copy
      </button>
    </div>
  );
}
