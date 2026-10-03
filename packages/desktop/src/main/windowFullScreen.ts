/**
 * Telling the renderer whether the window is full screen.
 *
 * On macOS the shell draws its own title bar - `hiddenInset` removes the native
 * one - and that bar exists for two things: a handle to drag the window by and
 * room for the traffic lights. Full screen has neither, so the bar is dead
 * space over the terminal. Only the BrowserWindow knows it went full screen,
 * and this is how it says so.
 *
 * ASKED once, then PUSHED. The preload asks synchronously when it starts,
 * before the page has run any code, so even a reload in full screen paints
 * its first frame right; a push on load arrived after React had already drawn
 * the windowed bar. Every change after that is pushed.
 */

/** Main to renderer: the window entered or left full screen. */
export const FULL_SCREEN_CHANNEL = 'window:fullScreen';
/** Renderer to main, synchronous: is my window full screen right now? */
export const FULL_SCREEN_QUERY = 'window:isFullScreen';

/** The slice of BrowserWindow this needs. Narrow, so a test can stand in. */
export interface FullScreenWindow {
  isFullScreen(): boolean;
  on(event: 'enter-full-screen' | 'leave-full-screen', cb: () => void): void;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/** The slice of ipcMain the query needs: a synchronous listener. */
export interface SyncIpcLike {
  on(channel: string, listener: (event: { sender: unknown; returnValue: unknown }) => void): void;
}

/**
 * Answer the preload's question for the window that asked.
 *
 * Always a boolean: `sendSync` returns whatever `returnValue` holds, and a
 * webContents with no window (a devtools frame, a window mid-teardown) must
 * read as windowed rather than as undefined.
 */
export function answerFullScreenQuery(
  ipc: SyncIpcLike,
  windowOf: (sender: unknown) => Pick<FullScreenWindow, 'isFullScreen'> | null,
): void {
  ipc.on(FULL_SCREEN_QUERY, event => {
    // ALWAYS answered: a listener that throws before setting returnValue
    // leaves the asking renderer blocked until main collects the event.
    let full = false;
    try { full = windowOf(event.sender)?.isFullScreen() === true; } catch { /* windowed */ }
    event.returnValue = full;
  });
}

export function wireFullScreen(win: FullScreenWindow): void {
  const tell = (): void => {
    // A full-screen window that closes leaves full screen on its way out, and
    // send on a destroyed webContents throws. See windowEmit.ts.
    if (win.webContents.isDestroyed()) return;
    win.webContents.send(FULL_SCREEN_CHANNEL, win.isFullScreen());
  };
  win.on('enter-full-screen', tell);
  win.on('leave-full-screen', tell);
}
