/**
 * The Appearance tab's preferences, and where they live.
 *
 * ── Where they are stored, stated plainly ──────────────────────────────────
 * `localStorage`, under one key, in this browser profile. Not the server: the
 * app plane has no settings write, and `/seen` is the overnight snapshot (it
 * advances at most once per server process - see `server/app/seen.ts`), not a
 * key-value store. Bending it into one would corrupt what it exists to
 * preserve. So: local, and the pane says so in words rather than implying a
 * setting that follows the operator to another machine.
 *
 * ── What they can actually change ─────────────────────────────────────────
 * Density and the mono font are token swaps, written straight onto
 * `document.documentElement.style` - no stylesheet needed, and they hold for
 * the whole app.
 *
 * Pulse and reduce-motion need a RULE, not a token (`.pulse`'s animation is
 * declared in tokens.css, which this chunk does not own), so this module injects
 * exactly one `<style>` element into `<head>` and toggles two classes on the
 * root. That is DOM, not an edit to another chunk's file.
 *
 * ── The honest limit ──────────────────────────────────────────────────────
 * Nothing here runs until this module is imported, and it is imported by the
 * Settings surface - which is lazy. So a session that never opens Settings runs
 * with the defaults. The pane says that in one sentence. The fix is one line in
 * the shell's `main.tsx` (`applyAppearance(readAppearance())`), and that file
 * belongs to the shell chunk, not this one.
 */

export type Density = "compact" | "editorial" | "comfortable";

export interface Appearance {
  /** Only "editorial" is built; the other five cards are drawn and say so. */
  theme: "editorial";
  density: Density;
  /** the family name that leads `--font-mono`; the rest of the stack survives */
  mono: string;
  pulse: boolean;
  reduceMotion: boolean;
}

const KEY = "sdl.ui3.appearance";
const STYLE_ID = "sdl-ui3-appearance";

/** The mock's own three rows, with the pixel values it prints in the labels. */
export const DENSITIES: { id: Density; label: string; rowHeight: string }[] = [
  { id: "compact", label: "Compact (32px)", rowHeight: "32px" },
  { id: "editorial", label: "Editorial (36px)", rowHeight: "36px" },
  { id: "comfortable", label: "Comfortable (44px)", rowHeight: "44px" },
];

/** The mock's three, in its order. The fallbacks after the chosen family are
 * tokens.css's own stack, so an unavailable font still lands somewhere sane. */
export const MONO_FONTS = ["Cascadia Mono", "SF Mono", "Consolas"];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "editorial",
  density: "editorial",
  mono: MONO_FONTS[0]!,
  pulse: true,
  reduceMotion: false,
};

export function readAppearance(): Appearance {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: "editorial",
      density: DENSITIES.some((entry) => entry.id === parsed.density) ? (parsed.density as Density) : DEFAULT_APPEARANCE.density,
      mono: typeof parsed.mono === "string" && MONO_FONTS.includes(parsed.mono) ? parsed.mono : DEFAULT_APPEARANCE.mono,
      pulse: typeof parsed.pulse === "boolean" ? parsed.pulse : DEFAULT_APPEARANCE.pulse,
      reduceMotion: typeof parsed.reduceMotion === "boolean" ? parsed.reduceMotion : DEFAULT_APPEARANCE.reduceMotion,
    };
  } catch {
    // A hand-edited or unavailable localStorage is not a crash: the defaults
    // are the mocks' own values, so the app looks exactly as drawn.
    return DEFAULT_APPEARANCE;
  }
}

/** Writes the preference. Returns the server-less truth the save bar prints:
 * either it landed in this browser profile, or it did not and why. */
export function writeAppearance(next: Appearance): { ok: true } | { ok: false; error: string } {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function ensureStyleElement(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ":root.sdl-no-pulse .pulse{animation:none;}",
    ":root.sdl-reduce-motion .pulse,:root.sdl-reduce-motion .fade-in{animation:none;}",
    ":root.sdl-reduce-motion *{transition-duration:0.01ms !important;}",
  ].join("\n");
  document.head.appendChild(style);
}

export function applyAppearance(appearance: Appearance): void {
  ensureStyleElement();
  const root = document.documentElement;
  const rowHeight = DENSITIES.find((entry) => entry.id === appearance.density)?.rowHeight ?? "32px";
  root.style.setProperty("--row-h", rowHeight);
  root.style.setProperty("--font-mono", `"${appearance.mono}","Cascadia Mono","SF Mono",Consolas,Menlo,monospace`);
  root.classList.toggle("sdl-no-pulse", !appearance.pulse);
  root.classList.toggle("sdl-reduce-motion", appearance.reduceMotion);
}
