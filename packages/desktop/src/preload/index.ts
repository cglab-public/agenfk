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
  /** Whether this agent has a flag to skip its own permission prompts. */
  readonly supportsAutoApprove: boolean;
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
  spawn(req: {
    itemId: string; agentId: string; cols: number; rows: number;
    autoApprove?: boolean;
    /** Keep the agent alive after the app quits, by running it inside tmux. */
    persist?: boolean;
    /** The conversation to resume. Omit on a fresh terminal; main mints one. */
    agentSessionId?: string;
    resume?: boolean;
  }): Promise<{
    /** Addresses the live process, for write/resize/kill. Dies with it. */
    sessionId: string;
    /**
     * Addresses the CONVERSATION, and is what makes a restored terminal worth
     * anything. Absent for agents that cannot be told their own id (codex).
     * Store it; it is the only way back.
     */
    agentSessionId?: string;
  }>;
  write(sessionId: string, data: string): Promise<boolean>;
  resize(sessionId: string, cols: number, rows: number): Promise<boolean>;
  kill(sessionId: string): Promise<boolean>;
  /** Returns an unsubscribe function; a tab that unmounts must stop listening. */
  onData(cb: (e: { sessionId: string; data: string }) => void): () => void;
  onExit(cb: (e: { sessionId: string; exitCode: number }) => void): () => void;
  /**
   * The agent said what it is doing, by setting the terminal title.
   *
   * Only ever 'working' or 'idle', and only on a CHANGE. 'unknown' never
   * crosses this boundary: an agent that publishes nothing has not told us it
   * stopped, and sending that would invite the renderer to treat silence as
   * rest — the mistake this replaces, in the opposite direction.
   */
  onActivity(cb: (e: { sessionId: string; activity: 'working' | 'idle' }) => void): () => void;
  listAgents(): Promise<AgentInfo[]>;
  refreshAgents(): Promise<AgentInfo[]>;
  /**
   * Whether a session survives quitting, and why not when it does not.
   *
   * Surfaced rather than assumed. A persistence feature that quietly does
   * nothing is indistinguishable from one that works until the day the user
   * closes the app and loses an agent mid-run.
   */
  sessionPersistence(): Promise<{ available: boolean; hint?: string; warning?: string }>;
}

/**
 * Preferences the desktop owns.
 *
 * Separate from the server's settings on purpose. `autoApprove` disables an
 * agent's permission prompts, and the server's settings route is
 * unauthenticated — so this one is reachable only through here, where the
 * caller has to be code running in this app's renderer.
 *
 * Named operations, one key at a time. There is no "save this object".
 */
/**
 * Opening a card's worktree in an editor.
 *
 * Named operations taking a CARD and an editor ID — never a path and never a
 * URL. The directory comes from the server's record of which worktree the card
 * owns, and the set of schemes the OS can be asked to launch is a closed list
 * in the main process. Handing the renderer a URL here would turn an XSS into
 * "run a local program with this argument".
 */
export interface AgenfkEditorsApi {
  list(): Promise<Array<{ id: string; label: string }>>;
  open(itemId: string, editorId: string): Promise<{ opened: boolean; path: string }>;
}

export interface AgenfkPrefsApi {
  get(): Promise<{ autoApprove: boolean }>;
  setAutoApprove(value: boolean): Promise<{ autoApprove: boolean }>;
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
  readonly prefs: AgenfkPrefsApi;
  readonly editors: AgenfkEditorsApi;
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
  onActivity: cb => subscribe('pty:activity', cb),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  sessionPersistence: () => ipcRenderer.invoke('sessions:persistence'),
  refreshAgents: () => ipcRenderer.invoke('agents:refresh'),
};

const prefs: AgenfkPrefsApi = {
  get: () => ipcRenderer.invoke('prefs:get'),
  // The value is normalised to a real boolean here as well as in main: the
  // renderer is our own bundle, but it is also the part an XSS would control.
  setAutoApprove: value => ipcRenderer.invoke('prefs:set', { key: 'autoApprove', value: value === true }),
};

const editors: AgenfkEditorsApi = {
  list: () => ipcRenderer.invoke('editors:list'),
  open: (itemId, editorId) => ipcRenderer.invoke('editors:open', { itemId, editorId }),
};

const api: AgenfkDesktopApi = {
  isDesktop: true,
  terminal,
  prefs,
  editors,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('agenfkDesktop', api);
