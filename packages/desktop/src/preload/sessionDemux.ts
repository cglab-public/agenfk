/**
 * One listener per channel, routed by session (CGLAB f2fa8fc4).
 *
 * The preload used to register an `ipcRenderer.on` PER SUBSCRIBER, and each
 * terminal pane subscribes to three channels. With N terminals that is N
 * listeners per channel, every chunk of output dispatched to all of them and
 * discarded by N−1 in the renderer. With N of them busy the aggregate is
 * O(N²): thirty terminals at a hundred chunks a second each is ninety thousand
 * listener invocations per second, of which about three thousand were wanted.
 *
 * It had a visible tell, too. `ipcRenderer` is a Node EventEmitter with a
 * default `maxListeners` of ten, so the eleventh terminal printed
 * `MaxListenersExceededWarning` — a leak detector firing on intended
 * behaviour, which is exactly how people learn to ignore a warning that will
 * one day be real.
 *
 * So: one real listener per channel, created on the first subscription and
 * removed with the last, and delivery keyed by `sessionId` so a payload
 * reaches only the session it belongs to rather than reaching everyone and
 * being filtered at the far end.
 *
 * WHAT THIS DELIBERATELY DOES NOT CARRY is Electron's `IpcRendererEvent`. The
 * preload's own comment gives the reason: it holds `sender`, a way back into
 * the main process that nothing in the renderer should have. Taking over
 * delivery must not quietly reintroduce it.
 */

/** The slice of ipcRenderer this needs, so a test can count registrations. */
export interface IpcLike {
  on(channel: string, handler: (event: unknown, payload: unknown) => void): void;
  off(channel: string, handler: (event: unknown, payload: unknown) => void): void;
}

type Subscriber = (payload: unknown) => void;

export interface SessionDemux {
  /** Subscribe to one session's payloads on a channel. Returns unsubscribe. */
  on(channel: string, sessionId: string, cb: Subscriber): () => void;
}

export function createSessionDemux(ipc: IpcLike): SessionDemux {
  /** channel → sessionId → subscribers. One `ipc.on` per channel, no more. */
  const channels = new Map<string, {
    handler: (event: unknown, payload: unknown) => void;
    bySession: Map<string, Set<Subscriber>>;
  }>();

  return {
    on(channel, sessionId, cb) {
      let entry = channels.get(channel);
      if (!entry) {
        const bySession = new Map<string, Set<Subscriber>>();
        const handler = (_event: unknown, payload: unknown): void => {
          // Main is trusted, but a channel that ever carries something else
          // must not throw from inside a dispatch loop and take every terminal
          // in the window with it.
          const id = (payload as { sessionId?: unknown } | null)?.sessionId;
          if (typeof id !== 'string') return;
          // A copy: a subscriber may unsubscribe from inside its own callback,
          // and React cleanups do exactly that.
          for (const sub of [...(bySession.get(id) ?? [])]) {
            try {
              // The payload alone. Never the event — see the header.
              sub(payload);
            } catch {
              /* One pane failing must not silence the others. */
            }
          }
        };
        entry = { handler, bySession };
        channels.set(channel, entry);
        ipc.on(channel, handler);
      }

      if (!entry.bySession.has(sessionId)) entry.bySession.set(sessionId, new Set());
      entry.bySession.get(sessionId)!.add(cb);

      return () => {
        const current = channels.get(channel);
        // Already torn down, or unsubscribed twice. `Set.delete` is idempotent
        // but the bookkeeping below is not, so this has to be checked.
        if (!current) return;
        const subs = current.bySession.get(sessionId);
        if (!subs?.delete(cb)) return;
        if (subs.size === 0) current.bySession.delete(sessionId);
        if (current.bySession.size > 0) return;
        // Nobody left on this channel: stop listening entirely rather than
        // holding a handler for output nobody reads.
        ipc.off(channel, current.handler);
        channels.delete(channel);
      };
    },
  };
}
