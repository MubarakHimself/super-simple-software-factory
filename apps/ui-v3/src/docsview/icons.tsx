/**
 * The three glyphs `docs-v3.html` draws that no other surface needs (the
 * shell's `shared/Icons.tsx` stays untouched - see the ownership note at the
 * top of this directory). Traced at the mock's own size and stroke.
 */
type IconProps = { className?: string };

export function TreeChevron({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 4l3 3 3-3" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 4h4l1 1h5v6H2z" strokeLinejoin="round" />
    </svg>
  );
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M3 2h6l2 2v6H3z" strokeLinejoin="round" />
    </svg>
  );
}
