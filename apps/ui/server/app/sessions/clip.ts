/**
 * Spec 1.3 rule (a): "every free-text field is clipped server-side:
 * title/summary 120 chars, detail 180 (the enforcement of 'less text' no
 * client can violate)". Applied in the adapters to `tool.title`/`tool.detail`
 * only - see types.ts's header comment for why `text.text` (the harness's
 * actual reply) is deliberately excluded.
 */
export function clipTitle(value: string): string {
  return clip(value, 120);
}

export function clipDetail(value: string): string {
  return clip(value, 180);
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Shell wrappers are stripped from displayed commands (spec 1.3): "the raw
 * form survives in the expanded detail" - so this only touches the title
 * side, never the full detail string a caller separately clips. */
const SHELL_WRAPPERS: RegExp[] = [
  /^pwsh(?:\.exe)?\s+-Command\s+/i,
  /^powershell(?:\.exe)?\s+-Command\s+/i,
  /^cmd(?:\.exe)?\s+\/c\s+/i,
  /^bash\s+-c\s+/i,
  /^sh\s+-c\s+/i,
];

export function stripShellWrapper(command: string): string {
  let out = command.trim();
  for (const re of SHELL_WRAPPERS) {
    const stripped = out.replace(re, "");
    if (stripped !== out) {
      out = stripped.replace(/^['"]|['"]$/g, "");
      break;
    }
  }
  return out;
}
