/**
 * The beat rail, rendered from the run's ACTUAL phase list (change-list #8:
 * chains differ, and the record is the truth). A run whose record holds no
 * phases gets no rail at all - five empty circles would imply a chain nobody
 * ran, which is exactly the kind of decoration this app refuses.
 *
 * `beat` (the server's fixed Plan/Build/Test/Review/Document table) is used as
 * the label when the phase's owner earns one; otherwise the phase's own name
 * shows, unchanged.
 */
import { beatSteps } from "./model.ts";
import type { RunPhase } from "./types.ts";

export function BeatRail({ phases }: { phases: RunPhase[] }) {
  const steps = beatSteps(phases);
  if (steps.length === 0) return null;
  return (
    <div className="beat-rail">
      {steps.map((step) => (
        <div className={`beat-step${step.state === "pending" ? "" : ` ${step.state}`}`} key={step.key}>
          <div className="beat-dot" />
          <span className="beat-label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}
