/**
 * The pi adapter - Open Decision 2 (spec 5.2): "pi's structured-output mode
 * (W1-1) ... Unverified on this machine ... REC: verify in the morning;
 * until then pi ships terminal-only in Sessions and the UI says so via the
 * can_steer/capability flags - never silent degradation."
 *
 * This file exists (the build plan names it explicitly) but does not
 * attempt to parse a JSON event stream from pi, because no such protocol has
 * been confirmed on this machine - `PI_PATH` was unset during this chunk's
 * build (readiness.ts already reports pi as `missing` here), and even with
 * it set, guessing a wire format and silently misparsing it would be worse
 * than the honest gap: an invented event shape is exactly what the
 * mock-data ban (spec's binding operator record) forbids, applied to a
 * protocol instead of a number.
 *
 * A Session created with `harness:"pi", mode:"chain"` therefore gets exactly
 * one explanatory event and ends - never a fake running chain, never a
 * silently-degraded one. The honest path for pi today is `mode:"terminal"`
 * (raw pty, no parsing needed - profiles.ts's `resolvePi()` still resolves
 * the real `PI_PATH` launch command for that path, verbatim from
 * `agent_pi.py._resolve_pi_cmd`'s contract).
 */
import type { AdapterHandle, AdapterStartOptions } from "../adapter.ts";

export function startPi(opts: AdapterStartOptions): AdapterHandle {
  // Deferred one tick so a caller that subscribes to onEvent synchronously
  // after calling startPi() (as store.ts does) still receives it - same
  // "emit after the caller has had a chance to attach" shape as
  // pty.ts's spawnNotFound, applied here to a chain Session instead of a
  // raw pty tab.
  queueMicrotask(() => {
    opts.onEvent({
      kind: "error",
      detail: "pi's structured-output mode is unverified on this machine (Open Decision 2) - use Terminal mode.",
    });
    opts.onEvent({ kind: "exit", code: 1 });
  });

  return {
    canSteer: false,
    input() {
      return false;
    },
    answer() {
      return false;
    },
    stop() {
      /* already ending itself via the microtask above */
    },
  };
}
