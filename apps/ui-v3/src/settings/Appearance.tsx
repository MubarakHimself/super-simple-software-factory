/**
 * Appearance (global — "Factory defaults"), settings-v3.html's last tab.
 *
 * All six theme cards are real: `tokens.css` carries a complete
 * `:root[data-theme="…"]` palette for each, derived from this pane's own
 * three-word description (Mission Console → cool dark, cyan, mono; Light
 * Workshop → bright, indigo, grotesque; Twilight Press → deep purple, rose,
 * serif; Carbon Grid → near-black, green, mono; Paper Notebook → warm light,
 * rust, serif). A click sets `document.documentElement`'s `data-theme`
 * attribute through `./appearance.ts`, which also states plainly where the
 * preference is stored — `localStorage`, in this browser profile, on this
 * machine, applied before first paint by `main.tsx` so switching (or
 * reloading on a non-default theme) never flashes the old palette.
 *
 * Density, mono font, pulse and reduce-motion are the other real controls
 * here: they rewrite the tokens on the document root and toggle two rules
 * injected by `./appearance.ts`. The save bar says "stored in this browser
 * profile" rather than "saved", because there is no server write behind any
 * of it and calling it saved would be the one lie this pane exists to avoid.
 */
import { useEffect, useState } from "react";
import type { SaveReporter } from "./save.ts";
import {
  DENSITIES,
  MONO_FONTS,
  THEMES,
  applyAppearance,
  readAppearance,
  writeAppearance,
  type Appearance as Prefs,
} from "./appearance.ts";

export function Appearance({ report }: { report: SaveReporter }) {
  const [prefs, setPrefs] = useState<Prefs>(readAppearance);

  // The stored preference is applied when this pane mounts too, so a
  // preference changed elsewhere (or a first read of a hand-edited
  // localStorage value) still paints correctly - `main.tsx` covers the boot
  // paint, this covers the pane re-asserting its own read.
  useEffect(() => {
    applyAppearance(prefs);
  }, [prefs]);

  const change = (next: Prefs, what: string, sentence: string) => {
    setPrefs(next);
    const result = writeAppearance(next);
    if (result.ok) report.local(`${sentence} — stored in this browser profile only, not on any server.`);
    else report.failed(what, result.error);
  };

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Appearance &amp; theme · <span className="scope-name-inline">Factory defaults</span>
      </div>
      <div className="form-panel-sub">
        Visual direction for the whole app. These preferences live in this browser profile on this machine — they do not
        travel to another machine, and nothing here is written into any project.
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Theme</span>
        </div>
        <div className="theme-cards">
          {THEMES.map((theme) => (
            <button
              type="button"
              key={theme.id}
              className={`theme-card${theme.id === prefs.theme ? " selected" : ""}`}
              onClick={() => change({ ...prefs, theme: theme.id }, "the theme", `Theme set to ${theme.name}`)}
            >
              <div className={`tc-swatch ${theme.id}`} />
              <div className="tc-name">{theme.name}</div>
              <div className="tc-desc">{theme.desc}</div>
            </button>
          ))}
        </div>
        <p className="section-note">
          Every theme here is a complete palette in <strong>tokens.css</strong> — switching is instant, and the choice
          holds across a reload.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Display</span>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Density</div>
            <div className="form-hint">Row height across the app</div>
          </div>
          <select
            className="form-select compact"
            value={prefs.density}
            onChange={(event) => {
              const density = DENSITIES.find((entry) => entry.id === event.target.value);
              if (!density) return;
              change({ ...prefs, density: density.id }, "density", `Density set to ${density.label}`);
            }}
          >
            {DENSITIES.map((density) => (
              <option key={density.id} value={density.id}>
                {density.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Mono font for data</div>
            <div className="form-hint">Used for IDs, paths, timestamps</div>
          </div>
          <select
            className="form-select compact"
            value={prefs.mono}
            onChange={(event) => change({ ...prefs, mono: event.target.value }, "the mono font", `Mono font set to ${event.target.value}`)}
          >
            {MONO_FONTS.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Status dots pulse</div>
            <div className="form-hint">Animate status indicators for running work</div>
          </div>
          <button
            type="button"
            className={`form-toggle${prefs.pulse ? " on" : ""}`}
            aria-label={`status dots pulse ${prefs.pulse ? "on" : "off"}`}
            onClick={() =>
              change(
                { ...prefs, pulse: !prefs.pulse },
                "the pulse setting",
                `Status dots ${prefs.pulse ? "no longer pulse" : "pulse again"}`,
              )
            }
          />
        </div>

        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Reduce motion</div>
            <div className="form-hint">Disable pulse animations and transitions</div>
          </div>
          <button
            type="button"
            className={`form-toggle${prefs.reduceMotion ? " on" : ""}`}
            aria-label={`reduce motion ${prefs.reduceMotion ? "on" : "off"}`}
            onClick={() =>
              change(
                { ...prefs, reduceMotion: !prefs.reduceMotion },
                "the reduce-motion setting",
                `Motion is ${prefs.reduceMotion ? "back on" : "reduced"}`,
              )
            }
          />
        </div>

        <p className="section-note">
          Your machine&apos;s own <strong>prefers-reduced-motion</strong> setting already silences every animation in this
          app; the switch above is the same promise made by hand.
        </p>
      </div>
    </div>
  );
}
