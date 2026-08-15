/**
 * Closes a transient (a dropdown, a menu) on an outside pointer-down or on
 * Escape.
 *
 * This is not a keybinding: nothing is invoked, nothing is navigated to. It
 * dismisses something that is already on screen, which is the one keyboard
 * behaviour the no-keybindings rule leaves standing - and the only one this
 * app has.
 */
import { useEffect, type RefObject } from "react";

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const host = ref.current;
      if (host && event.target instanceof Node && !host.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, open, close]);
}
