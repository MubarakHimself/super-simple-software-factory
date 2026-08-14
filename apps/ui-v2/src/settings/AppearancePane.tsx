/**
 * Appearance (spec 2.8, W3-C3): "light / dark / system segmented control; one
 * density control. Bare labels - **no description line under controls** (that
 * is precisely what makes T3's settings text-heavy)."
 *
 * So: two labels, six words of chrome, and nothing else on the page. The
 * mockup's lede paragraph and its three `Change` rows are deliberately not
 * carried - they are the text the operator's binding note is about.
 */
import { useTheme, type Theme } from "../lib/theme.ts";
import { useDensity, type Density } from "./density.ts";
import { Pane, Section, Segmented } from "./parts.tsx";

const THEMES: readonly { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const DENSITIES: readonly { id: Density; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "comfortable", label: "Comfortable" },
];

export function AppearancePane() {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useDensity();

  return (
    <Pane heading="Appearance">
      {/* Side by side, not stacked: two controls are two controls, and a
          column of them down the left edge of a wide pane was most of what the
          operator's "the spacing makes no sense" was pointing at. Nothing is
          added here to fill the rest - this surface has exactly two settings
          that do something, and both of them are on this line. */}
      <div className="flex flex-wrap gap-x-16 gap-y-6">
        <Section label="Theme">
          <Segmented ariaLabel="Theme" options={THEMES} value={theme} onChange={setTheme} />
        </Section>
        <Section label="Density">
          <Segmented ariaLabel="Density" options={DENSITIES} value={density} onChange={setDensity} />
        </Section>
      </div>
    </Pane>
  );
}
