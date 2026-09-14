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
