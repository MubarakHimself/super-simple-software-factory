/**
 * The topbar's "Auto-pick from Ready" indicator (board-v3.html), portaled
 * into the shell's `TOPBAR_SLOT_ID` exactly where the mock draws it - left
 * of Sync.
 *
 * The sentence itself never changes ("no dispatch button exists anywhere",
 * J3.2) - what changes is whether this laptop can vouch for it happening
 * right now, read straight from the same `factory/health` the footer strip
 * uses (`useShell().health` - never a second copy of that read).
 */
import { createPortal } from "react-dom";
import type { FactoryHealth } from "../lib/api.ts";
import type { Resource } from "../lib/poll.ts";
import { useTopbarSlot } from "../shell/TopBar.tsx";
import { Dot, type Tone } from "../shared/Dot.tsx";

function view(health: Resource<FactoryHealth>): { tone: Tone; pulse: boolean; text: string } {
  const engine = health.data?.engine;
  if (engine === "running") return { tone: "ok", pulse: true, text: "Auto-pick from Ready" };
  if (engine === "stopped") return { tone: "fail", pulse: false, text: "Auto-pick paused — engine stopped" };
  // No read yet, a failed read, or an honest "unknown": the model still has
  // no dispatch button, so the sentence stays - the dot just stops claiming
  // to know the engine is alive.
  return { tone: "idle", pulse: false, text: "Auto-pick from Ready · engine status unknown" };
}

export function AutoPickIndicator({ health }: { health: Resource<FactoryHealth> }) {
  const host = useTopbarSlot();
  if (!host) return null;
  const { tone, pulse, text } = view(health);
  return createPortal(
    <div className="auto-pick-indicator" title="The factory auto-picks Ready cards when a lane frees up. There is no dispatch button.">
      <Dot tone={tone} pulse={pulse} />
      <span className="api-text">{text}</span>
    </div>,
    host,
  );
}
