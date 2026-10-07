/**
 * Applying the stored zoom to a window, and keeping it when the keyboard
 * changes it (INFRA-425).
 *
 * Electron's default View menu already zoomed on Ctrl+= and Ctrl+-, and forgot
 * the result on the next launch, so the person on a scaled WSLg monitor fixed
 * the size every morning. This takes the three shortcuts over: each press goes
 * through `stepUiScale`, is written to prefs.json, applied to the window, and
 * pushed to the renderer so an open Settings screen shows the new value.
 *
 * Applied on EVERY load, not once: a reload is a new document, and Chromium
 * keys zoom by host, which a reload keeps but a navigation to the adopt-failure
 * page does not.
 *
 * Known gap, accepted: clicking View > Zoom In with the mouse still zooms
 * without storing it. The menu is Electron's default and is not ours to edit
 * here; the shortcut is the path people use.
 */
import { readPrefs, readablePrefs, writePref } from './prefs.js';
import { stepUiScale, zoomShortcut, type KeyInput } from './appearance.js';

/** Main to renderer: preferences changed without the renderer asking. */
export const PREFS_CHANGED_CHANNEL = 'prefs:changed';

/** The slice of BrowserWindow this needs. Narrow, so a test can stand in. */
export interface ScalableWindow {
  readonly webContents: {
    isDestroyed(): boolean;
    setZoomFactor(factor: number): void;
    getZoomFactor(): number;
    send(channel: string, payload: unknown): void;
    on(event: 'did-finish-load', cb: () => void): void;
    on(event: 'before-input-event', cb: (event: { preventDefault(): void }, input: KeyInput) => void): void;
  };
}

export function wireUiScale(win: ScalableWindow, prefsDir: () => string, platform: NodeJS.Platform): void {
  const contents = win.webContents;

  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return;
    contents.setZoomFactor(readPrefs(prefsDir()).uiScale);
  });

  contents.on('before-input-event', (event, input) => {
    const direction = zoomShortcut(input, platform);
    if (!direction) return;
    // Stops the page AND the menu accelerator, so the press is not applied
    // twice: once here and once more by View > Zoom In.
    event.preventDefault();
    const dir = prefsDir();
    /*
     * From the zoom the window is AT, not the stored one: when the file cannot
     * be written the stored value never moves, and stepping from it would land
     * every press on the same stored+0.1.
     */
    const next = stepUiScale(contents.getZoomFactor(), direction);
    /*
     * The zoom still happens when the file cannot be written (a read-only
     * profile, a full disk): the press was already taken from the page, and a
     * throw here would surface as Electron's main-process error dialog for a
     * keystroke. It just will not be remembered.
     */
    let stored = null;
    try {
      stored = writePref(dir, 'uiScale', next);
    } catch (e) {
      console.warn('[DESKTOP] Could not store the zoom:', (e as Error).message);
    }
    if (contents.isDestroyed()) return;
    contents.setZoomFactor(next);
    // The narrowed slice, as prefs:get answers: the renderer writes this
    // straight into its cache.
    if (stored) contents.send(PREFS_CHANGED_CHANNEL, readablePrefs(stored));
  });
}
