/**
 * Measuring a pane's own width, for the one responsive rule the app has
 * (spec 3.4: a rail takes layout width above 1200px of pane and overlays
 * below it).
 *
 * Why this is a hook and not four lines in each surface: the rule has two
 * traps, both of which the app fell into once, and a comment repeated in two
 * files is not a guard.
 *
 * **Trap 1 - zero is not narrow.** A box that has not been laid out yet
 * measures 0. Read literally, that says "narrower than any threshold", so the
 * rail stands down on a 1920px screen. A zero is ignored here rather than
 * obeyed.
 *
 * **Trap 2 - the element arrives after the effect that wants it.** Runs
 * redirects `/runs` -> `/runs/:adw_id` when it has rows and none is named. On
 * the render that returns `<Navigate>` the measured div does not exist, and
 * React Router keeps the surface MOUNTED across that redirect (both paths
 * render the same element), so a `useEffect(..., [])` holding a `useRef` runs
 * once, against `null`, and never again: the ResizeObserver is either never
 * attached or left observing a detached node. `wide` then freezes at whatever
 * it last was - which is why the Diff rail was reported "missing when Runs is
 * reached through its own redirect", and why the same arrival at 1360px kept
 * a full-width rail that should have overlaid.
 *
 * A **callback ref** is the fix, because React calls it with the node every
 * time the node changes - including the first time it appears, several renders
 * after mount - and with `null` when it goes away. So the observer follows the
 * element instead of assuming it was there at mount.
 *
 * Returns `null` until a real measurement lands, so a caller can distinguish
 * "not measured yet" from "measured, and narrow".
 */
import { useCallback, useRef, useState } from "react";

export function usePaneWidth<T extends HTMLElement>(): [(element: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;

    const measure = (next: number) => {
      if (next >= 1) setWidth(next); // trap 1
    };
    measure(element.getBoundingClientRect().width);

    const next = new ResizeObserver((entries) => {
      const observed = entries[0]?.contentRect.width;
      if (typeof observed === "number") measure(observed);
    });
    next.observe(element);
    observer.current = next;
  }, []);

  return [ref, width];
}
