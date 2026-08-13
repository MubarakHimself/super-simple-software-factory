/**
 * Lets a session opened OUTSIDE the Terminal surface (spec 5.2's "Deploy"
 * button, in Settings) show up as a real tab there ("opens a Terminal tab -
 * section 3 - so it is visible, scrollable and interruptible"), without the
 * two components sharing a state library. Module-level, not a React
 * context, on purpose: a Deploy click can happen while the Terminal surface
 * is unmounted (the app fully unmounts the previous surface on nav, see
 * routes.tsx), so a session opened before TerminalSurface (re)mounts must
 * survive until it does - a plain queue drained on mount does that with no
 * extra machinery.
 */
export interface ExternalSession {
  sessionId: string;
  label: string;
}

const pending: ExternalSession[] = [];
type Listener = (session: ExternalSession) => void;
const listeners = new Set<Listener>();

/** Called by whoever opened the session (e.g. the Server pane's Deploy
 * button) with a sessionId main already minted. If TerminalSurface is
 * mounted right now, it shows up immediately; otherwise it waits in
 * `pending` until the next mount drains it. */
export function announceExternalSession(sessionId: string, label: string): void {
  const session: ExternalSession = { sessionId, label };
  if (listeners.size === 0) {
    pending.push(session);
    return;
  }
  for (const listener of listeners) listener(session);
}

/** Called once by TerminalSurface on mount: drains anything announced while
 * it was unmounted, then subscribes for future announcements. Returns the
 * unsubscribe function. */
export function drainAndSubscribeExternalSessions(listener: Listener): () => void {
  while (pending.length > 0) listener(pending.shift()!);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
