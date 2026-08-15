/**
 * Appearance (global — "Factory defaults"), settings-v3.html's last tab.
 *
 * Six theme cards are drawn; ONE is built. Editorial Instrument is this app's
 * design system — the tokens in `tokens.css` are its palette, and the other
 * five would each need their own. So the five carry a "not built" badge on the
 * card itself, and clicking one says so in a sentence instead of silently doing
 * nothing (the mock's `selectTheme()` moves the selection ring and pretends).
 *
 * Density, mono font, pulse and reduce-motion are REAL here: they rewrite the
 * tokens on the document root and toggle two rules injected by
 * `./appearance.ts`, which also states plainly where the preference is stored —
 * `localStorage`, in this browser profile, on this machine. The save bar says
 * "stored in this browser profile" rather than "saved", because there is no
 * server write behind any of it and calling it saved would be the one lie this
 * pane exists to avoid.
 */
import { useEffect, useState } from "react";
import type { SaveReporter } from "./save.ts";
import {
  DENSITIES,
  MONO_FONTS,
  applyAppearance,
  readAppearance,
  writeAppearance,
  type Appearance as Prefs,
} from "./appearance.ts";

/** The mock's own six cards, in its order, with its own swatch classes and
 * descriptions. Only the first has tokens behind it. */
const THEMES: { id: string; name: string; desc: string; built: boolean }[] = [
  { id: "editorial", name: "Editorial Instrument", desc: "Warm dark · amber · serif", built: true },
  { id: "mission", name: "Mission Console", desc: "Cool dark · cyan · mono", built: false },
  { id: "workshop", name: "Light Workshop", desc: "Bright · indigo · grotesque", built: false },
  { id: "twilight", name: "Twilight Press", desc: "Deep purple · rose · serif", built: false },
  { id: "carbon", name: "Carbon Grid", desc: "Near-black · green · mono", built: false },
  { id: "paper", name: "Paper Notebook", desc: "Warm light · rust · serif", built: false },
];

export function Appearance({ report }: { report: SaveReporter }) {
  const [prefs, setPrefs] = useState<Prefs>(readAppearance);
  const [themeNote, setThemeNote] = useState<string | null>(null);

  // The stored preference is applied when this pane mounts. `appearance.ts`
  // says why that is the honest limit of this wave and what the one-line fix
  // in the shell would be; the note at the bottom of this pane says it too.
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
              className={`theme-card${theme.built ? " selected" : ""}`}
              onClick={() =>
                setThemeNote(
                  theme.built
                    ? null
                    : `${theme.name} is drawn, not built — Editorial Instrument is the only palette this app has tokens for, so it stays selected.`,
                )
              }
            >
              <div className={`tc-swatch ${theme.id}`} />
              <div className="tc-name">
                {theme.name}
                {theme.built ? null : <span className="tc-later">not built</span>}
              </div>
              <div className="tc-desc">{theme.desc}</div>
            </button>
          ))}
        </div>
        {themeNote ? <p className="section-note">{themeNote}</p> : null}
        <p className="section-note">
          One theme ships in this build. The other five are the drawing&apos;s own list, kept visible so the plan is
          legible — each needs its own palette in <strong>tokens.css</strong> before it can be selected.
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
          app; the switch above is the same promise made by hand. Both of these preferences take effect from the moment
          this tab is opened in a session — the app reads them when Settings loads, not at startup.
        </p>
      </div>
    </div>
  );
}
