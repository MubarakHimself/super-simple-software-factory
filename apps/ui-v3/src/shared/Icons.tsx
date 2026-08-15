/**
 * The shell's icons, traced from the mocks' inline SVG - same 14x14 viewBox,
 * same 1.5 stroke, same paths. They are components rather than files so the
 * bundle stays one origin with no font and no sprite sheet to fetch.
 *
 * A Phase 2 surface that needs a new icon should add it here in this shape
 * (viewBox 0 0 14 14, `fill="none" stroke="currentColor" strokeWidth="1.5"`),
 * copied from the mock that introduces it.
 */
import type { ReactNode } from "react";

type IconProps = { className?: string };

function Svg({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {children}
    </svg>
  );
}

export function ChevronDown({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 6l3 3 3-3" strokeLinecap="round" />
    </Svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M9.5 9.5L12 12" strokeLinecap="round" />
    </Svg>
  );
}

export function HomeIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2 6l5-4 5 4v6H2z" strokeLinejoin="round" />
      <path d="M5 12V8h4v4" />
    </Svg>
  );
}

export function BoardIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="2" y="2" width="3" height="10" rx="1" />
      <rect x="6" y="2" width="3" height="7" rx="1" />
      <rect x="10" y="2" width="2" height="5" rx="1" />
    </Svg>
  );
}

export function RunsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2 7h3l2-4 3 8 2-4h2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function DocsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 2h6l2 2v8H3z" strokeLinejoin="round" />
      <path d="M5 6h4M5 9h4" />
    </Svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="7" cy="7" r="2" />
      <path
        d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.4 1.4M10.1 10.1l1.4 1.4M2.5 11.5l1.4-1.4M10.1 3.9l1.4-1.4"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function HelpIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="7" cy="7" r="5" />
      <path d="M5.5 5.5a1.5 1.5 0 0 1 3 0c0 1-.5 1.5-1 2v1" strokeLinecap="round" />
      <circle cx="7" cy="10" r="0.5" fill="currentColor" />
    </Svg>
  );
}

export function SyncIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M11 3a5 5 0 1 0 1.5 4" strokeLinecap="round" />
      <path d="M11 1v3h-3" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** The report card's "Review merge queue" CTA, from home-v2.html's `.primary-cta`. */
export function BookmarkIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 2v10l4-3 4 3V2z" strokeLinejoin="round" />
    </Svg>
  );
}
