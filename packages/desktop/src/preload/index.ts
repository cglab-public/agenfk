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
import { createSessionDemux } from './sessionDemux.js';

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
  /**
   * Report how much of what was sent has actually been drawn.
   *
   * The return path of the flow control in flowControl.ts: main stops reading
   * from the pty when too much is in flight and undrawn, and this is the only
   * thing that tells it the terminal caught up. A renderer that stops calling
   * it gets its session force-resumed after a grace period rather than frozen.
   */
  ack(sessionId: string, bytes: number): Promise<boolean>;
  kill(sessionId: string): Promise<boolean>;
  /** Returns an unsubscribe function; a tab that unmounts must stop listening. */
  /**
   * One session's output. SESSION-SCOPED on purpose: a broadcast subscription
   * meant N listeners on one channel and every chunk dispatched to all of
   * them, which is O(N²) with N busy terminals and printed a
   * MaxListenersExceededWarning at the eleventh. See sessionDemux.ts.
   */
  onData(sessionId: string, cb: (e: { sessionId: string; data: string }) => void): () => void;
  onExit(sessionId: string, cb: (e: { sessionId: string; exitCode: number }) => void): () => void;
  /**
   * The agent said what it is doing, by setting the terminal title.
   *
   * Only a state the agent actually published, and only on a CHANGE. Codex
   * says 'Action Required' in its title when it wants a person, so 'blocked'
   * crosses here too. 'unknown' never
   * crosses this boundary: an agent that publishes nothing has not told us it
   * stopped, and sending that would invite the renderer to treat silence as
   * rest — the mistake this replaces, in the opposite direction.
   */
  onActivity(sessionId: string, cb: (e: { sessionId: string; activity: 'working' | 'blocked' | 'idle' }) => void): () => void;
  listAgents(): Promise<AgentInfo[]>;
  refreshAgents(): Promise<AgentInfo[]>;
  /**
   * Ask one agent for a decomposition and get back what it printed.
   *
   * Not a terminal: the question has one answer and no follow-up, so this runs
   * the agent's own non-interactive mode and returns stdout.
   */
  propose(req: { projectId: string; agentId: string; objective: string }): Promise<{ stdout: string }>;
  /**
   * What the agent is printing WHILE it runs — both streams, line by line.
   *
   * The answer still arrives through `propose`; this is so a run that is
   * thinking, a run that is asking for a login and a run that is wedged stop
   * looking identical from the outside.
   */
  onProposeOutput(cb: (e: { stream: 'stdout' | 'stderr'; line: string }) => void): () => void;
  /** Open the native folder picker and turn the choice into a project. */
  addProjectFromDirectory(): Promise<{ id: string; name: string } | null>;
  /**
   * The same door in two steps, which is what the screen needs: choose the
   * folder (the path comes back only to be SHOWN, with the name it suggests),
   * then create with a name the person may have changed. The renderer never
   * supplies a path — `projectRoot` stays behind the main process.
   */
  chooseProjectFolder(): Promise<{ path: string; name: string } | null>;
  addChosenFolder(name: string): Promise<{ id: string; name: string }>;
  /** Where a clone would land today, remembered between runs. */
  cloneDir(): Promise<{ path: string }>;
  /** Open the picker and remember the answer. */
  chooseCloneDir(): Promise<{ path: string | null }>;
  /** Clone a repository and return the project it became. */
  cloneRepository(url: string, name: string): Promise<{ id: string; name: string }>;
  /** Who this machine can create a repository as. Empty means not signed in. */
  githubOwners(): Promise<{ login: string; avatarUrl: string | null; self: boolean }[]>;
  createRepository(req: {
    owner: string; repo: string; visibility: 'private' | 'public'; name: string;
  }): Promise<{ id: string; name: string }>;
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

/**
 * The notification sound.
 *
 * Note what is NOT here: any way to name a file. `choose` opens the OS picker
 * in the main process and `read` reads whatever was stored by it — neither
 * takes a path, so a renderer has nothing to supply and nothing to point at.
 * That is the same rule `spawn` follows one interface up, arrived at for the
 * same reason: a general-purpose surface here turns an XSS in this bundle into
 * filesystem access on the user's machine.
 */
export interface AgenfkSoundsApi {
  /** Which file is in use, for the screen to name. Null means the built-in cue. */
  current(): Promise<{ name: string | null }>;
  /** Opens the picker. `error` explains a file that was refused. */
  choose(): Promise<{ name: string | null; error?: string }>;
  clear(): Promise<{ name: string | null }>;
  /**
   * The chosen sound's BYTES, as a data URL.
   *
   * Bytes rather than a path because the renderer is sandboxed and has no
   * filesystem: a path would be a string it can do nothing with.
   */
  read(): Promise<{ dataUrl: string | null; name: string | null }>;
}

/**
 * OS banners.
 *
 * The renderer ASKS; main decides whether to show one. Whether the window is
 * in front is a fact only main can see — `document.hasFocus()` answers a
 * different question — so the "only when unfocused" rule is not something the
 * caller can assert or override from here.
 */
export interface AgenfkNotificationsApi {
  attention(notice: { agentLabel: string; cardTitle?: string }): Promise<boolean>;
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
  readonly sounds: AgenfkSoundsApi;
  readonly notifications: AgenfkNotificationsApi;
}

/**
 * Wraps a main-process event in an unsubscribe function.
 *
 * The listener is wrapped rather than passed through so the renderer never
 * receives Electron's IpcRendererEvent — that object carries `sender`, which
 * is a way back into the main process that nothing in the renderer should have.
 */
/**
 * One demux for every terminal event, shared by every pane in this window.
 * See sessionDemux.ts: one ipcRenderer listener per channel, not one per pane.
 */
const demux = createSessionDemux(ipcRenderer);

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.off(channel, handler); };
}

const terminal: AgenfkTerminalApi = {
  spawn: req => ipcRenderer.invoke('pty:spawn', req),
  write: (sessionId, data) => ipcRenderer.invoke('pty:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', { sessionId, cols, rows }),
  ack: (sessionId, bytes) => ipcRenderer.invoke('pty:ack', { sessionId, bytes }),
  kill: sessionId => ipcRenderer.invoke('pty:kill', { sessionId }),
  onData: (sessionId, cb) => demux.on('pty:data', sessionId, cb as never),
  onExit: (sessionId, cb) => demux.on('pty:exit', sessionId, cb as never),
  onActivity: (sessionId, cb) => demux.on('pty:activity', sessionId, cb as never),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  sessionPersistence: () => ipcRenderer.invoke('sessions:persistence'),
  refreshAgents: () => ipcRenderer.invoke('agents:refresh'),
  // One question to one agent. Ids and a sentence in, what it printed out.
  propose: req => ipcRenderer.invoke('agents:propose', req),
  onProposeOutput: cb => subscribe('agents:proposeOutput', cb),
  // No arguments in, a project out. The path stays in the main process.
  addProjectFromDirectory: () => ipcRenderer.invoke('projects:addFromDirectory'),
  chooseProjectFolder: () => ipcRenderer.invoke('projects:chooseFolder'),
  addChosenFolder: (name: string) => ipcRenderer.invoke('projects:addChosenFolder', { name }),
  cloneDir: () => ipcRenderer.invoke('projects:cloneDir'),
  chooseCloneDir: () => ipcRenderer.invoke('projects:chooseCloneDir'),
  cloneRepository: (url, name) => ipcRenderer.invoke('projects:cloneRepository', { url, name }),
  githubOwners: () => ipcRenderer.invoke('github:owners'),
  createRepository: req => ipcRenderer.invoke('github:createRepository', req),
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

const sounds: AgenfkSoundsApi = {
  current: () => ipcRenderer.invoke('sounds:current'),
  // No arguments, deliberately. See AgenfkSoundsApi.
  choose: () => ipcRenderer.invoke('sounds:choose'),
  clear: () => ipcRenderer.invoke('sounds:clear'),
  read: () => ipcRenderer.invoke('sounds:read'),
};

const notifications: AgenfkNotificationsApi = {
  attention: notice => ipcRenderer.invoke('notifications:attention', {
    // Narrowed here as well as in main: the renderer is our own bundle, but it
    // is also the part an XSS would control, and this text ends up rendered by
    // the operating system.
    agentLabel: String(notice?.agentLabel ?? ''),
    cardTitle: notice?.cardTitle === undefined ? undefined : String(notice.cardTitle),
  }),
};

const api: AgenfkDesktopApi = {
  isDesktop: true,
  terminal,
  prefs,
  editors,
  sounds,
  notifications,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('agenfkDesktop', api);
