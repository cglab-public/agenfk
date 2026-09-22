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
  /**
   * The pty surface, as much of it as a caller outside TerminalPane needs.
   *
   * Optional in the TYPE for the same reason `sessionPersistence` is: the
   * renderer bundle and the preload are separate artifacts, and a desktop
   * build made before `projectId` existed exposes `spawn` without it. Calling
   * blind would take the screen down over a feature that is merely absent.
   */
  spawn?(req: {
    itemId?: string; projectId?: string; agentId: string; cols: number; rows: number;
  }): Promise<{ sessionId: string }>;
  write?(sessionId: string, data: string): Promise<unknown>;
  onData?(sessionId: string, cb: (e: { sessionId: string; data: string }) => void): () => void;
  kill?(sessionId: string): Promise<unknown>;
  /** One question to one agent; what it printed comes back. */
  propose?(req: { projectId: string; agentId: string; objective: string }): Promise<{ stdout: string }>;
  onProposeOutput?(cb: (e: { stream: 'stdout' | 'stderr'; line: string }) => void): () => void;
  /** Open the native folder picker and turn the choice into a project. */
  addProjectFromDirectory?(): Promise<{ id: string; name: string } | null>;
  /** Choose the folder; the project is created afterwards, under a name. */
  chooseProjectFolder?(): Promise<{ path: string; name: string } | null>;
  addChosenFolder?(name: string): Promise<{ id: string; name: string }>;
  cloneDir?(): Promise<{ path: string }>;
  chooseCloneDir?(): Promise<{ path: string | null }>;
  cloneRepository?(url: string, name: string): Promise<{ id: string; name: string }>;
  githubOwners?(): Promise<{ login: string; avatarUrl: string | null; self: boolean }[]>;
  createRepository?(req: {
    owner: string; repo: string; visibility: 'private' | 'public'; name: string;
  }): Promise<{ id: string; name: string }>;
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
/**
 * Open an agent on an OBJECTIVE, in a project, with no card.
 *
 * Returns null when this build cannot: an older main process has no such path,
 * and the screen says so rather than opening a session somewhere arbitrary.
 */
export const openObjectiveSession = async (
  req: { projectId: string; agentId: string; cols: number; rows: number },
): Promise<{ sessionId: string } | null> => {
  const api = bridge();
  if (!api?.spawn) return null;
  return api.spawn(req);
};

export const writeToSession = (sessionId: string, data: string): Promise<unknown> | null =>
  bridge()?.write?.(sessionId, data) ?? null;

export const onSessionData = (
  sessionId: string,
  cb: (data: string) => void,
): (() => void) | null => {
  const api = bridge();
  if (!api?.onData) return null;
  return api.onData(sessionId, ({ data }) => cb(data));
};

export const killSession = (sessionId: string): void => { void bridge()?.kill?.(sessionId); };

/**
 * Ask an agent for a decomposition and get back what it printed.
 *
 * Returns null when this build has no such path — an older packaged app, or a
 * browser — so the screen can say which of those it is instead of appearing to
 * do nothing.
 */
export const proposeFromBridge = (
  req: { projectId: string; agentId: string; objective: string },
): Promise<{ stdout: string }> | null => bridge()?.propose?.(req) ?? null;

/**
 * Ask for a folder and get back the project it became.
 *
 * No argument and no path in the answer: `projectRoot` is a CWD behind an
 * internal token, so the main process owns both the picker and the write.
 * Null means the person cancelled; missing means this build cannot do it.
 */
/**
 * Subscribe to what the agent prints while it is being asked.
 *
 * Returns the unsubscribe, or null where this build cannot report it — the
 * screen then keeps its old behaviour instead of pretending to stream.
 */
export const onProposeOutputFromBridge = (
  cb: (e: { stream: 'stdout' | 'stderr'; line: string }) => void,
): (() => void) | null => bridge()?.onProposeOutput?.(cb) ?? null;

export const addProjectFromDirectory = (): Promise<{ id: string; name: string } | null> | null =>
  bridge()?.addProjectFromDirectory?.() ?? null;

/**
 * The same door in two steps, which is the one the screen uses.
 *
 * `choose` answers with the folder and the name it suggests — both only to be
 * SHOWN — and `add` creates under whatever name survived the edit. What goes
 * back is text; the path stays where it was chosen.
 */
export const chooseProjectFolderFromBridge = ():
  Promise<{ path: string; name: string } | null> | null =>
  bridge()?.chooseProjectFolder?.() ?? null;

export const addChosenFolderFromBridge = (name: string):
  Promise<{ id: string; name: string }> | null =>
  bridge()?.addChosenFolder?.(name) ?? null;

/**
 * Where a clone would land, and the picker that changes it.
 *
 * A path travels OUT so the screen can show where the clone will go before it
 * runs — the rule is that the renderer never invents one, not that it may
 * never see one.
 */
export const cloneDirFromBridge = (): Promise<{ path: string }> | null =>
  bridge()?.cloneDir?.() ?? null;

export const chooseCloneDirFromBridge = (): Promise<{ path: string | null }> | null =>
  bridge()?.chooseCloneDir?.() ?? null;

/** Clone a repository and get back the project it became. */
export interface GitHubOwner { login: string; avatarUrl: string | null; self: boolean }

/**
 * Who this machine can create a repository as.
 *
 * An EMPTY list and a missing bridge are different answers: empty means gh is
 * there and signed out (a state with an instruction), missing means this build
 * cannot do it at all.
 */
export const githubOwnersFromBridge = (): Promise<GitHubOwner[]> | null =>
  bridge()?.githubOwners?.() ?? null;

export const createRepositoryFromBridge = (req: {
  owner: string; repo: string; visibility: 'private' | 'public'; name: string;
}): Promise<{ id: string; name: string }> | null =>
  bridge()?.createRepository?.(req) ?? null;

export const cloneRepositoryFromBridge = (url: string, name: string):
  Promise<{ id: string; name: string }> | null =>
  bridge()?.cloneRepository?.(url, name) ?? null;

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

/**
 * The notification sound and OS banners.
 *
 * Every one of these degrades to "not here" in a browser, and that is the
 * literal truth rather than a fallback: a page has no file picker that can
 * write into the app's own directory, no filesystem to read the bytes back
 * from, and no window whose focus the app can ask about. The built-in tone
 * still works there, because it is Web Audio and needs nobody's help.
 *
 * `typeof` rather than `?.` throughout, for the reason `sessionPersistence`
 * carries above: the renderer bundle and the preload are separate artifacts and
 * can be mismatched, so a desktop build made before this existed exposes
 * `agenfkDesktop` without these — and calling one blind threw a TypeError that
 * took down whatever was rendering.
 */
interface SoundsBridgeApi {
  current?(): Promise<{ name: string | null }>;
  choose?(): Promise<{ name: string | null; error?: string }>;
  clear?(): Promise<{ name: string | null }>;
  read?(): Promise<{ dataUrl: string | null; name: string | null }>;
}

interface NotificationsBridgeApi {
  attention?(notice: { agentLabel: string; cardTitle?: string }): Promise<boolean>;
}

const soundsBridge = (): SoundsBridgeApi | null =>
  (window as unknown as { agenfkDesktop?: { sounds?: SoundsBridgeApi } }).agenfkDesktop?.sounds ?? null;

const notificationsBridge = (): NotificationsBridgeApi | null =>
  (window as unknown as { agenfkDesktop?: { notifications?: NotificationsBridgeApi } })
    .agenfkDesktop?.notifications ?? null;

/** Whether this build can offer a custom sound at all. Drives whether the row exists. */
export const canChooseSound = (): boolean => typeof soundsBridge()?.choose === 'function';

/**
 * Whether this build can raise an OS banner.
 *
 * Separate from `canChooseSound` on purpose. They are different bridges, and a
 * preload older than one of them exposes the other - so asking about sounds to
 * decide what to say about banners tells a desktop user they need the desktop
 * app, which is the version-skew failure this file's helpers exist to avoid.
 */
export const canNotifyAttention = (): boolean =>
  typeof notificationsBridge()?.attention === 'function';

export const currentSoundFromBridge = (): Promise<{ name: string | null }> => {
  const sounds = soundsBridge();
  if (typeof sounds?.current !== 'function') return Promise.resolve({ name: null });
  return sounds.current();
};

export const chooseSoundOnBridge = (): Promise<{ name: string | null; error?: string }> => {
  const sounds = soundsBridge();
  if (typeof sounds?.choose !== 'function') {
    // Refused loudly rather than silently doing nothing: the settings screen
    // must be able to tell the user the picker did not open.
    return Promise.reject(new Error('This build cannot choose a sound file.'));
  }
  return sounds.choose();
};

export const clearSoundOnBridge = (): Promise<{ name: string | null }> => {
  const sounds = soundsBridge();
  if (typeof sounds?.clear !== 'function') {
    return Promise.reject(new Error('This build cannot change the sound.'));
  }
  return sounds.clear();
};

/**
 * The chosen sound's BYTES.
 *
 * Null in a browser, which sends the caller to the built-in tone — the correct
 * outcome rather than a degraded one, since there is no chosen file to read.
 */
export const readSoundFromBridge = (): Promise<{ dataUrl: string; name: string } | null> => {
  const sounds = soundsBridge();
  if (typeof sounds?.read !== 'function') return Promise.resolve(null);
  return sounds.read().then(r => (r?.dataUrl ? { dataUrl: r.dataUrl, name: r.name ?? '' } : null));
};

/**
 * Ask for an OS banner.
 *
 * Resolves false where there is no main process to ask, rather than rejecting:
 * this is called from the render path that also draws the sessions rail, and a
 * rejection nobody caught would surface as an unhandled rejection on every
 * blocked agent in a browser tab.
 */
export const notifyAttentionOnBridge = (
  notice: { agentLabel: string; cardTitle?: string },
): Promise<boolean> => {
  const notifications = notificationsBridge();
  if (typeof notifications?.attention !== 'function') return Promise.resolve(false);
  return notifications.attention(notice).catch(() => false);
};
