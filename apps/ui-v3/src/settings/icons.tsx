/**
 * The one icon Settings needs that the shell's `shared/Icons.tsx` does not
 * already carry: the plus on "Add a new provider…" and "+ Add server".
 *
 * Traced from settings-v3.html's own inline SVG (viewBox 0 0 14 14, stroke 1.5,
 * `d="M7 3v8M3 7h8"`). It lives here rather than in `shared/Icons.tsx` because
 * that file belongs to the shell chunk; when the shell adopts it, this file
 * becomes a re-export.
 */
export function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M7 3v8M3 7h8" strokeLinecap="round" />
    </svg>
  );
}
