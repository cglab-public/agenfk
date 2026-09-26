/**
 * Sending a message to one window (CGLAB a1cd226e).
 *
 * Separated from index.ts for the same reason `adoptFailure` was: the decision
 * is small, it has one branch that matters, and testing it inside the Electron
 * bootstrap would mean standing up an app object to observe two lines.
 *
 * TO ONE WINDOW, never broadcast. A session's output belongs to the window
 * that opened it, and broadcasting would put one card's shell — including
 * whatever the agent prints — into every other open window.
 *
 * The guard is the part worth having tested. A `BrowserWindow` can still be
 * enumerable while its `webContents` is already destroyed, and `send` on a
 * destroyed webContents THROWS. This is called from inside node-pty's `onData`
 * emitter, so that throw escapes into the data callback of a live session and
 * takes the forward, the title reader and the flow-control accounting with it
 * — all for a window that is on its way out anyway.
 */

/** The slice of Electron this needs. Narrow, so a test can stand in. */
export interface WindowLike {
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export type Emit = (windowId: number, channel: string, payload: unknown) => void;

/**
 * Build the emitter, given a way to list the windows that exist right now.
 *
 * The list is fetched per call rather than captured, so nothing here holds a
 * reference to a window past its lifetime — which is what made the enumerable
 * but destroyed case possible in the first place, and is still the right
 * trade: a stale reference would be worse.
 */
export function makeEmit(getWindows: () => readonly WindowLike[]): Emit {
  return (windowId, channel, payload) => {
    const target = getWindows().find(w => w.webContents.id === windowId);
    // Gone, or going. Either way there is nobody to tell, and saying so is
    // what throws.
    if (!target || target.webContents.isDestroyed()) return;
    target.webContents.send(channel, payload);
  };
}
