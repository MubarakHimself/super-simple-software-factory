/**
 * The four icons runs-gate-v3.html introduces, traced from its own inline SVG
 * (same viewBoxes, same 1.5 stroke, same paths). They live here rather than in
 * src/shared/Icons.tsx because they belong to this surface; the shared file
 * keeps the shell's set.
 */
type IconProps = { className?: string };

/** Export bar, "Copy prompt". */
export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <path d="M5 1h6a1 1 0 0 1 1 1v6" strokeLinecap="round" />
    </svg>
  );
}

/** Export bar, "Open in Claude Code". */
export function StarIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M7 1l1.5 4L12 5l-3 2.5L10 12l-3-2L4 12l1-4.5L2 5l3.5 0z" strokeLinejoin="round" />
    </svg>
  );
}

/** The cooldown badge's clock. */
export function ClockIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="5" cy="5" r="3.5" />
      <path d="M5 3v2.5l2 1" strokeLinecap="round" />
    </svg>
  );
}

/** The merge-queue badge's tick. */
export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 5l2.5 2.5L8 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
