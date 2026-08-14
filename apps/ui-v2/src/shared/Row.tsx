/**
 * The one row (spec 3.6: "one row component (slash menu = ask card =
 * palette)"). Geometry is the filed `codex-app-slash-menu.png`: 28px, icon,
 * name left, one-line description RIGHT-ALIGNED, never wraps.
 *
 * The description is clipped by the caller (`clip`) rather than by CSS alone,
 * so the same text reads the same in every one of the three surfaces.
 */
import type { ReactNode } from "react";

export function Row({
  icon,
  label,
  description,
  trailing,
  selected = false,
  disabled = false,
  title,
  onSelect,
  onMouseEnter,
}: {
  icon?: ReactNode;
  label: ReactNode;
  description?: string | null;
  /** A keycap, count, or badge pinned after the description. */
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      title={title}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={[
        "flex h-menurow w-full shrink-0 items-center gap-2 px-3 text-left text-body",
        disabled ? "cursor-default text-t3" : "text-t2 hover:bg-row-hover hover:text-t1",
        selected ? "bg-row-active text-t1 shadow-[inset_2px_0_0_var(--accent)]" : "",
      ].join(" ")}
    >
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center text-t3">{icon}</span> : null}
      <span className="min-w-0 shrink-0 truncate">{label}</span>
      {description ? (
        <span className="ml-auto min-w-0 truncate pl-4 text-right text-meta text-t3">{description}</span>
      ) : null}
      {trailing ? <span className={description ? "shrink-0 pl-3" : "ml-auto shrink-0 pl-3"}>{trailing}</span> : null}
    </button>
  );
}
