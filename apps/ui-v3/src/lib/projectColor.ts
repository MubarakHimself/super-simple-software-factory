/**
 * The per-project accent.
 *
 * The mocks colour-code each project and repaint `--accent` on switch (see
 * home-v2.html's `switchProject`). The manifest has no colour field and this
 * app invents no operator data, so the colour is DERIVED from the project's
 * position in `/api/app/projects` - deterministic, stable while the manifest
 * is, and identical on every machine that reads the same manifest.
 *
 * The four values are the mocks' own switcher palette, in the mocks' order.
 */
export const PROJECT_COLORS = ["#e0a64a", "#6ba4e8", "#6dbb6e", "#7d7568"] as const;

export function colorForIndex(index: number): string {
  const safe = index < 0 ? 0 : index;
  return PROJECT_COLORS[safe % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

export function colorForProject(projects: { id: string }[], projectId: string): string {
  return colorForIndex(projects.findIndex((project) => project.id === projectId));
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Repaints the accent for the whole document, exactly as the mock does - plus
 * the two tokens derived from it. Swapping `--accent` alone would leave every
 * accent-tinted surface amber under a blue project, which is the drift the
 * mock's own switcher has; the derived pair keeps a switched project coherent.
 *
 * `--on-accent` (the near-black text ON the accent) stays fixed: all four
 * palette colours are light enough to carry it.
 */
export function applyAccent(color: string): void {
  const [r, g, b] = channels(color);
  const root = document.documentElement.style;
  root.setProperty("--accent", color);
  root.setProperty("--accent-surface", `rgba(${r},${g},${b},0.08)`);
  root.setProperty("--row-active", `rgba(${r},${g},${b},0.05)`);
  // #e0a64a -> #493622, which is the mock's own --accent-dim (#4a3820) to
  // within a shade: a third of the accent, sitting on the warm canvas.
  const dim = [r, g, b].map((channel) => Math.round(channel * 0.33).toString(16).padStart(2, "0")).join("");
  root.setProperty("--accent-dim", `#${dim}`);
}
