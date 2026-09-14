/**
 * Reaching the main process's agent detection from the renderer (CGLAB-169).
 *
 * One place rather than a copy in each component, because the browser fallback
 * matters: in a browser there is no bridge at all, and a component that assumed
 * one would throw on a page where terminals simply do not exist.
 */
import type { AgentInfo } from './AgentPicker';

interface TerminalBridgeApi {
  listAgents(): Promise<AgentInfo[]>;
  /**
   * Optional in the TYPE, required in the current preload.
   *
   * The renderer bundle and the preload are separate artifacts and can be
   * mismatched: a desktop build made before this method existed still exposes a
   * `terminal` object, just without it. Calling it blind threw a TypeError that
   * took the whole dialog down, so the user could not open a terminal at all
   * over a feature that is merely a warning label.
   *
   * That the CURRENT preload exposes it is guarded at the source, by
   * `ipcSurface.test.ts` comparing the handler list to the preload.
   */
  sessionPersistence?(): Promise<{ available: boolean; hint?: string; warning?: string }>;
}

const bridge = (): TerminalBridgeApi | null =>
  (window as unknown as { agenfkDesktop?: { terminal?: TerminalBridgeApi } })
    .agenfkDesktop?.terminal ?? null;

/**
 * Desktop-owned preferences.
 *
 * Deliberately not part of the server's settings: `autoApprove` disables an
 * agent's permission prompts, and the server's settings route is
 * unauthenticated and reachable by anything on the machine. Here the only
 * caller is code running in this app's renderer.
 */
interface PrefsBridgeApi {
  get(): Promise<{ autoApprove: boolean }>;
  setAutoApprove(value: boolean): Promise<{ autoApprove: boolean }>;
}

const prefsBridge = (): PrefsBridgeApi | null =>
  (window as unknown as { agenfkDesktop?: { prefs?: PrefsBridgeApi } }).agenfkDesktop?.prefs ?? null;

/**
 * `false` where there is no desktop host, and that is the truth rather than a
 * fallback: a browser has no terminals for the setting to apply to.
 *
 * `typeof`, not `?.` — the object can be present while the method is not, which
 * is what an older preload looks like after an upgrade.
 */
export const readPrefsFromBridge = (): Promise<{ autoApprove: boolean }> => {
  const prefs = prefsBridge();
  if (typeof prefs?.get !== 'function') return Promise.resolve({ autoApprove: false });
  return prefs.get();
};

export const setAutoApproveOnBridge = (value: boolean): Promise<{ autoApprove: boolean }> => {
  const prefs = prefsBridge();
  if (typeof prefs?.setAutoApprove !== 'function') {
    // Refused loudly rather than silently doing nothing: the settings screen
    // must be able to tell the user the change did not land.
    return Promise.reject(new Error('This build cannot store that preference.'));
  }
  return prefs.setAutoApprove(value);
};

/** Empty in a browser: there are no local CLIs to offer a page. */
export const listAgentsFromBridge = (): Promise<AgentInfo[]> =>
  bridge()?.listAgents() ?? Promise.resolve([]);

/**
 * Whether a terminal here outlives the app.
 *
 * `false` in a browser, and that is the literal truth rather than a fallback:
 * a page has no process to keep alive once the tab is gone.
 */
export const sessionPersistenceFromBridge = (): Promise<{
  available: boolean; hint?: string; warning?: string;
}> => {
  const terminal = bridge();
  // `typeof`, not `?.` — the object can be there while the method is not.
  if (typeof terminal?.sessionPersistence !== 'function') return Promise.resolve({ available: false });
  return terminal.sessionPersistence();
};

/**
 * Editors installed on this machine, and opening a card's worktree in one.
 *
 * Empty in a browser, which is the truth rather than a fallback: there is no
 * worktree on a page. `typeof` rather than `?.` because an older preload can
 * expose the object without the method.
 */
interface EditorsBridgeApi {
  list?(): Promise<Array<{ id: string; label: string }>>;
  open?(itemId: string, editorId: string): Promise<{ opened: boolean; path: string }>;
}

const editorsBridge = (): EditorsBridgeApi | null =>
  (window as unknown as { agenfkDesktop?: { editors?: EditorsBridgeApi } }).agenfkDesktop?.editors ?? null;

export const listEditorsFromBridge = (): Promise<Array<{ id: string; label: string }>> => {
  const editors = editorsBridge();
  if (typeof editors?.list !== 'function') return Promise.resolve([]);
  return editors.list();
};

export const openInEditorFromBridge = (itemId: string, editorId: string): Promise<unknown> => {
  const editors = editorsBridge();
  if (typeof editors?.open !== 'function') {
    // Refused loudly: a click that silently does nothing is the failure this
    // whole feature is supposed to replace.
    return Promise.reject(new Error('This build cannot open an editor.'));
  }
  return editors.open(itemId, editorId);
};
