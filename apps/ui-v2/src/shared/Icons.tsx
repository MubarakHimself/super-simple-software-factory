/**
 * Icons: hand-drawn 16px strokes, one weight, no icon library.
 *
 * Spec 1.2: "UI glyphs (dots, checks, chevrons) are drawn with CSS/SVG, not
 * shipped to any console" - the server console stays ASCII, and these never
 * leave the browser. They are stroke-only on `currentColor` so a row's own
 * text color is the only thing that decides how an icon reads.
 *
 * Not in spec 4's file list; the alternative was the same six paths pasted
 * into four shell files.
 */
import type { ReactNode } from "react";

type IconProps = { className?: string };

const BASE = "size-4 shrink-0";

function svg(path: ReactNode, { className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${BASE} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const IconChevronDown = (p: IconProps) => svg(<path d="m4 6.2 4 4 4-4" />, p);
export const IconSearch = (p: IconProps) =>
  svg(
    <>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="m10.4 10.4 3 3" />
    </>,
    p,
  );
export const IconPlus = (p: IconProps) => svg(<path d="M8 3.4v9.2M3.4 8h9.2" />, p);
/** A prompt and a caret - the Terminal surface's row. */
export const IconTerminal = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m4.6 6.4 2 1.8-2 1.8M8.6 10.4h3" />
    </>,
    p,
  );
export const IconBoard = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="3" width="3.6" height="10" rx=".8" />
      <rect x="6.6" y="3" width="3.6" height="7" rx=".8" />
      <rect x="11.2" y="3" width="3" height="9" rx=".8" />
    </>,
    p,
  );
export const IconRuns = (p: IconProps) =>
  svg(
    <>
      <path d="M3 4h6M3 8h10M3 12h7" />
      <circle cx="12.4" cy="4" r="1.6" />
    </>,
    p,
  );
export const IconGate = (p: IconProps) =>
  svg(
    <>
      <path d="M8 2.2 13.2 4v4.1c0 3-2.2 5-5.2 5.8-3-.8-5.2-2.8-5.2-5.8V4z" />
      <path d="M5.9 8.1 7.4 9.6l3-3.2" />
    </>,
    p,
  );
export const IconDocs = (p: IconProps) =>
  svg(
    <>
      <path d="M4 2.2h5l3 3v8.6H4z" />
      <path d="M9 2.4v3h3M6 9h4M6 11h3" />
    </>,
    p,
  );
export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </>,
    p,
  );
export const IconFile = (p: IconProps) => svg(<path d="M4 2.6h4.6L12 6v7.4H4z" />, p);
export const IconFolder = (p: IconProps) =>
  svg(<path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3.1l1.4 1.6h5.1A1.2 1.2 0 0 1 14 5.8v6A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z" />, p);
export const IconSession = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <path d="m5 6.5 2 1.7-2 1.7M8.6 10.4h3" />
    </>,
    p,
  );
export const IconPanel = (p: IconProps) =>
  svg(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <path d="M6.2 3v10" />
    </>,
    p,
  );
