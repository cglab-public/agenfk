/**
 * Preload — the only bridge between the renderer and the main process.
 *
 * This file is a security boundary, not a convenience layer. The renderer runs
 * the same bundle a browser would, so anything exposed here is reachable by
 * every script in that bundle. Expose named, narrow operations; never a
 * general-purpose escape hatch like `spawn` or `ipcRenderer` itself.
 *
 * The UI uses the presence of `window.agenfkDesktop` to decide whether to
 * render the desktop shell (sidebar + session tabs) or stay the plain board
 * it is in a browser — see CGLAB-168.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
}

/**
 * Terminals (CGLAB-169).
 *
 * Named operations only. There is deliberately no `exec`, no channel name
 * parameter and no `ipcRenderer` passthrough: the renderer runs the same bundle
 * a browser would, so anything general-purpose exposed here turns an XSS into
 * code execution on the user's machine, in their repository.
 *
 * `spawn` takes an ITEM and an AGENT. It cannot take a directory or a command —
 * the main process resolves both, the first from the server's record of which
 * worktree a card owns and the second from a closed list.
 */
export interface AgenfkTerminalApi {
  spawn(req: { itemId: string; agentId: string; cols: number; rows: number }): Promise<string>;
  write(sessionId: string, data: string): Promise<boolean>;
  resize(sessionId: string, cols: number, rows: number): Promise<boolean>;
  kill(sessionId: string): Promise<boolean>;
  /** Returns an unsubscribe function; a tab that unmounts must stop listening. */
  onData(cb: (e: { sessionId: string; data: string }) => void): () => void;
  onExit(cb: (e: { sessionId: string; exitCode: number }) => void): () => void;
  listAgents(): Promise<AgentInfo[]>;
  refreshAgents(): Promise<AgentInfo[]>;
}

export interface AgenfkDesktopApi {
  /** Marks this as the desktop shell. Checked by the UI at startup. */
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  readonly terminal: AgenfkTerminalApi;
}

/**
 * Wraps a main-process event in an unsubscribe function.
 *
 * The listener is wrapped rather than passed through so the renderer never
 * receives Electron's IpcRendererEvent — that object carries `sender`, which
 * is a way back into the main process that nothing in the renderer should have.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.off(channel, handler); };
}

const terminal: AgenfkTerminalApi = {
  spawn: req => ipcRenderer.invoke('pty:spawn', req),
  write: (sessionId, data) => ipcRenderer.invoke('pty:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', { sessionId, cols, rows }),
  kill: sessionId => ipcRenderer.invoke('pty:kill', { sessionId }),
  onData: cb => subscribe('pty:data', cb),
  onExit: cb => subscribe('pty:exit', cb),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  refreshAgents: () => ipcRenderer.invoke('agents:refresh'),
};

const api: AgenfkDesktopApi = {
  isDesktop: true,
  terminal,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('agenfkDesktop', api);
