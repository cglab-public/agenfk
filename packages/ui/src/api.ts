import axios from 'axios';
import { AgEnFKItem, ItemType, Status, Flow, RegistryFlow } from './types'; // We need to copy types or import from core if possible, but symlinking in Vite monorepo can be tricky without proper setup.
import { API_URL } from './apiUrl';

/** One check's verdict on a verify (CGLAB-380), as the server records it. */
export interface StepCheckResult {
  id: string;
  step: string;
  source: 'universal' | 'role' | 'flow';
  severity: 'block' | 'warn';
  params: Record<string, string>;
  outcome: 'pass' | 'fail' | 'unavailable' | 'n/a' | 'deferred';
  detail: string;
  blocking: boolean;
  overridden?: GateOverride;
}
export interface GateOverride { id: string; by: string; at: string; reason: string }
/** The human gates of a card's current step (CGLAB-382). */
export interface StepGates {
  step: string;
  approvalRequired: boolean;
  /** The step's human-approval check asks for acts signed with a passkey (CGLAB-383). */
  passkeyRequired?: boolean;
  approvals: Array<{ id?: string; by: string; at: string; note?: string; authority?: string; from?: string }>;
  overrides: Record<string, GateOverride>;
  lastChecks: { step: string; at: string; blocked: boolean; results: StepCheckResult[] } | null;
}
// For MVP, we'll duplicate the types interface or use `any`.
// Better: configure vite to aliase @agenfk/core to the local package.

/**
 * The settings payload, declared once.
 *
 * Written out here rather than inline on each method because this epic has
 * repeatedly produced a value in one place and consumed it in another with the
 * shape restated by hand — and the restatements drifted every time.
 */
/**
 * A terminal to put back.
 *
 * `agentSessionId` absent means the tab can be reopened but the conversation
 * cannot be resumed — true of codex, which cannot be told its own id. Absent
 * has to read as "fresh start", never as a missing record.
 */
export interface TerminalSessionDto {
  id: string;
  itemId: string;
  projectId?: string;
  agentId: string;
  agentSessionId?: string;
  /** Whether the session lives inside tmux. Identity — see BUG 63fcf702. */
  persist?: boolean;
  /** What it was created with. Baked into the tmux session name. */
  autoApprove?: boolean;
  /** The card's title, so a restored tab has a name and not a uuid. */
  itemTitle?: string;
  openedAt: string;
}

/** Where a notification sound may play. Mirrors core's `SoundTiming`. */
export type SoundTimingDto = 'always' | 'unfocused';

/**
 * The installation's settings, as the wire sees them.
 *
 * A COPY of core's `AppSettings`, and it has to be one: `@agenfk/core` compiles
 * to CommonJS, and importing it from the browser bundle is the mistake
 * `claimState.ts` documents at length — a named import fails the build, a
 * namespace import ships a black window that throws `exports is not defined`
 * while every test and the build itself report success.
 *
 * A copy that DRIFTS is worse than either sharing or not, and the drift here
 * has a specific shape: a setting added to core and not to this type is one the
 * screen cannot write, refused at runtime by a route the caller cannot see. So
 * `appSettingsDto.test.ts` pins the two together — that test CAN import core,
 * because it runs where core resolves to source.
 */
export interface AppSettingsDto {
  tmuxByDefault: boolean;
  attentionAlerts: boolean;
  attentionSound: boolean;
  soundTiming: SoundTimingDto;
  osNotifications: boolean;
}

export const api = {
  listProjects: async () => {
    try {
      const { data } = await axios.get(`${API_URL}/projects`);
      return data;
    } catch (e) {
      console.error("API Error listing projects:", e);
      throw e;
    }
  },
  /**
   * Runs across every project (CGLAB-170).
   *
   * Distinct from listAgentRuns, which is per card. The Sessions rail asks
   * "what is running anywhere", and asking that per project from here would be
   * one request per project on every socket event.
   */
  listRuns: async (params: { status?: string; limit?: number } = {}) => {
    try {
      const { data } = await axios.get(`${API_URL}/agent-runs`, { params });
      return data;
    } catch (e) {
      console.error('API Error listing runs:', e);
      return [];
    }
  },

  listAgentRuns: async (itemId: string) => {
    try {
      const { data } = await axios.get(`${API_URL}/items/${itemId}/agent-runs`);
      return data;
    } catch (e) {
      console.error('API Error listing agent runs for', itemId, e);
      throw e;
    }
  },
  listRunEvents: async (runId: string) => {
    try {
      const { data } = await axios.get(`${API_URL}/agent-runs/${runId}/events`);
      return data;
    } catch (e) {
      console.error('API Error listing run events for', runId, e);
      throw e;
    }
  },
  /**
   * Every item in a working step, across all projects, in ONE request.
   *
   * The server decides what "active" means, per project, against that
   * project's own flow — the same definition the gatekeeper uses. Filtering
   * client-side instead would mean a second copy of that rule, free to drift.
   */
  listActiveItems: async () => {
    try {
      const { data } = await axios.get(`${API_URL}/items`, { params: { active: 'true' } });
      return data;
    } catch (e) {
      console.error("API Error listing active items:", e);
      throw e;
    }
  },
  createProject: async (project: { name: string; description?: string }) => {
    try {
      const { data } = await axios.post(`${API_URL}/projects`, project);
      return data;
    } catch (e) {
      console.error("API Error creating project:", e);
      throw e;
    }
  },
  deleteProject: async (id: string) => {
    try {
      await axios.delete(`${API_URL}/projects/${id}`);
    } catch (e) {
      console.error('API Error deleting project', id, e);
      throw e;
    }
  },
  listItems: async (params?: { type?: string; status?: string; parentId?: string; includeArchived?: boolean; projectId?: string }) => {
    try {
      const { data } = await axios.get(`${API_URL}/items`, { 
        params: {
          ...params,
          includeArchived: params?.includeArchived ? 'true' : undefined
        }
      });
      return data;
    } catch (e) {
      console.error("API Error listing items:", e);
      throw e;
    }
  },
  getItem: async (id: string) => {
    try {
      const { data } = await axios.get(`${API_URL}/items/${id}`);
      return data;
    } catch (e) {
      console.error('API Error getting item', id, e);
      throw e;
    }
  },
  createItem: async (item: Partial<AgEnFKItem>) => {
    try {
      const { data } = await axios.post(`${API_URL}/items`, item);
      return data;
    } catch (e) {
      console.error("API Error creating item:", e);
      throw e;
    }
  },
  /**
   * What a session's worktree has changed.
   *
   * Errors rather than answering "clean" when the worktree is missing or is
   * not a repository — the caller has to be able to tell those apart, because
   * a clean tree is the one thing a user opens this to check.
   */
  getGitStatus: async (itemId: string): Promise<{
    changed: number;
    staged: number;
    files: Array<{ path: string; staged: boolean; state: string; from?: string }>;
  }> => {
    try {
      const { data } = await axios.get(`${API_URL}/items/${itemId}/git-status`);
      return data;
    } catch (e) {
      console.error('API Error reading git status for', itemId, e);
      throw e;
    }
  },

  /**
   * Terminals to put back, and the conversations they held.
   *
   * The server filters out sessions whose card is gone or trashed, so what
   * comes back here is what can actually be opened.
   */
  /**
   * The unified diff of one file in the item's worktree (be411ffb).
   *
   * `staged` picks `git diff --cached`, so the panel's two tabs diff the half
   * they are showing rather than always the working tree.
   */
  getFileDiff: async (itemId: string, filePath: string, staged: boolean): Promise<{
    path: string; staged: boolean; diff: string;
  }> => {
    try {
      const { data } = await axios.get(`${API_URL}/items/${itemId}/diff`, {
        params: { path: filePath, staged },
      });
      return data;
    } catch (e) {
      console.error('API Error reading file diff for', filePath, e);
      throw e;
    }
  },

  listTerminalSessions: async (projectId?: string): Promise<TerminalSessionDto[]> => {
    try {
      const { data } = await axios.get(`${API_URL}/terminal-sessions`, {
        params: projectId ? { projectId } : undefined,
      });
      return data;
    } catch (e) {
      console.error('API Error reading terminal sessions:', e);
      throw e;
    }
  },
  recordTerminalSession: async (session: {
    itemId: string; projectId?: string; agentId: string; agentSessionId?: string;
    /*
     * Identity, not preference. Without these the restore cannot rebuild the
     * tmux session name, so it never finds the session that survived — see
     * BUG 63fcf702.
     */
    persist?: boolean; autoApprove?: boolean;
  }): Promise<TerminalSessionDto> => {
    try {
      const { data } = await axios.post(`${API_URL}/terminal-sessions`, session);
      return data;
    } catch (e) {
      console.error('API Error recording terminal session:', e);
      throw e;
    }
  },
  forgetTerminalSession: async (id: string): Promise<void> => {
    try {
      await axios.delete(`${API_URL}/terminal-sessions/${id}`);
    } catch (e) {
      console.error('API Error forgetting terminal session', id, e);
      throw e;
    }
  },

  /**
   * Installation-wide settings. Global, not per project.
   *
   * The read never fails into "unknown": the server answers a fresh install
   * with the documented defaults rather than a 404, so callers never have to
   * invent their own idea of what off means.
   */
  getSettings: async (): Promise<AppSettingsDto> => {
    try {
      const { data } = await axios.get(`${API_URL}/settings`);
      return data;
    } catch (e) {
      console.error('API Error reading settings:', e);
      throw e;
    }
  },
  /**
   * Patches: keys left out keep their stored value.
   *
   * Returns the whole settled state, so a caller never has to re-read to find
   * out what it now has.
   */
  updateSettings: async (patch: Partial<AppSettingsDto>): Promise<AppSettingsDto> => {
    try {
      const { data } = await axios.put(`${API_URL}/settings`, patch);
      return data;
    } catch (e) {
      console.error('API Error updating settings:', e);
      throw e;
    }
  },

  updateItem: async (id: string, updates: Partial<AgEnFKItem>) => {
    try {
      // The board header: the server lets only the board move a card forward
      // outside verify, and records each such move on the card (CGLAB-377).
      const { data } = await axios.put(`${API_URL}/items/${id}`, updates, { headers: { 'x-agenfk-ui': '1' } });
      return data;
    } catch (e) {
      console.error('API Error updating item', id, e);
      throw e;
    }
  },
  /** The card's current step: go-ahead needed, approvals, overrides, last checks (CGLAB-382). */
  getGates: async (id: string): Promise<StepGates> => {
    const { data } = await axios.get(`${API_URL}/items/${id}/gates`);
    return data;
  },
  /** A person's go-ahead for the card's current step. The board header is what the server accepts. */
  approveStep: async (id: string, body: { step: string; note?: string; assertion?: unknown }) => {
    const { data } = await axios.post(`${API_URL}/items/${id}/approvals`, body, { headers: { 'x-agenfk-ui': '1' } });
    return data;
  },
  /** A person's pass of one blocked check, with the reason they wrote. */
  overrideCheck: async (id: string, body: { step: string; checkId: string; reason: string; assertion?: unknown }) => {
    const { data } = await axios.post(`${API_URL}/items/${id}/overrides`, body, { headers: { 'x-agenfk-ui': '1' } });
    return data;
  },
  /** Passkeys enrolled on this board (CGLAB-383). */
  getPasskeyStatus: async (): Promise<{ enrolled: boolean; credentials: Array<{ id: string; createdAt?: string | null }> }> => {
    const { data } = await axios.get(`${API_URL}/webauthn/status`);
    return data;
  },
  /** A single-use challenge bound to one act: a signature over it authorises that act only. */
  passkeyChallenge: async (act: Record<string, string>): Promise<{ challenge: string; allowCredentials: string[] }> => {
    const { data } = await axios.post(`${API_URL}/webauthn/challenge`, act, { headers: { 'x-agenfk-ui': '1' } });
    return data;
  },
  enrollPasskey: async (registration: unknown, assertion?: unknown) => {
    const { data } = await axios.post(`${API_URL}/webauthn/credentials`, { registration, ...(assertion ? { assertion } : {}) }, { headers: { 'x-agenfk-ui': '1' } });
    return data;
  },
  bulkUpdateItems: async (items: { id: string; updates: Partial<AgEnFKItem> }[]) => {
    try {
      const { data } = await axios.post(`${API_URL}/items/bulk`, { items }, { headers: { 'x-agenfk-ui': '1' } });
      return data;
    } catch (e) {
      console.error(`API Error bulk updating items:`, e);
      throw e;
    }
  },
  deleteItem: async (id: string) => {
    try {
      await axios.delete(`${API_URL}/items/${id}`);
    } catch (e) {
      console.error('API Error deleting item', id, e);
      throw e;
    }
  },
  moveItem: async (id: string, targetProjectId: string): Promise<{ item: AgEnFKItem; movedCount: number }> => {
    try {
      const { data } = await axios.post(`${API_URL}/items/${id}/move`, { targetProjectId });
      return data;
    } catch (e) {
      console.error('API Error moving item', id, 'to project', targetProjectId, e);
      throw e;
    }
  },
  trashArchivedItems: async (projectId: string) => {
    try {
      const { data } = await axios.post(`${API_URL}/items/trash-archived`, { projectId });
      return data;
    } catch (e) {
      console.error('API Error trashing archived items for project', projectId, e);
      throw e;
    }
  },
  getJiraStatus: async (): Promise<{ configured: boolean; connected: boolean; cloudId?: string; email?: string; message?: string; reason?: string }> => {
    const { data } = await axios.get(`${API_URL}/jira/status`);
    return data;
  },
  disconnectJira: async (): Promise<void> => {
    try {
      await axios.post(`${API_URL}/jira/disconnect`);
    } catch (e) {
      console.error('API Error disconnecting JIRA:', e);
      throw e;
    }
  },
  listJiraProjects: async (): Promise<{ id: string; key: string; name: string }[]> => {
    const { data } = await axios.get(`${API_URL}/jira/projects`);
    return data;
  },
  listJiraIssues: async (projectKey: string, params?: { summary?: string; statusCategory?: string }): Promise<{ id: string; key: string; summary: string; issueType: string; status: string; statusCategory?: string; priority?: string }[]> => {
    const { data } = await axios.get(`${API_URL}/jira/projects/${projectKey}/issues`, { params });
    return data;
  },
  importJiraIssues: async (projectId: string, items: { issueKey: string; type: string }[]): Promise<void> => {
    await axios.post(`${API_URL}/jira/import`, { projectId, items });
  },
  getGitHubStatus: async (projectId: string): Promise<{ configured: boolean; owner?: string; repo?: string; ghCliAuthenticated?: boolean }> => {
    try {
      const { data } = await axios.get(`${API_URL}/github/status`, { params: { projectId } });
      return data;
    } catch {
      return { configured: false };
    }
  },
  /**
   * Who this machine is signed in to GitHub as.
   *
   * Deliberately not `getGitHubStatus` with more fields: that one is
   * PROJECT-scoped and answers which repo a card maps to. An account belongs to
   * the installation, and conflating the two is how a settings screen reports
   * "not connected" because no project happens to have a repo configured.
   *
   * There is no second credential behind this. The server asks `gh`, which is
   * the same credential `agenfk github setup` already depends on.
   */
  getGitHubAccount: async (): Promise<
    | { connected: true; login: string; name: string | null; email: string | null; avatarUrl: string | null }
    | { connected: false; reason: 'gh_missing' | 'not_authenticated' | 'unreadable' }
  > => {
    try {
      // The same preflight-forcing header the write routes use. This one is a
      // GET, and a simple GET is not gated by CORS at all - the request is
      // issued and executed even when the response cannot be read - so without
      // it any page the user visits could drive an 8-second `gh` call in a loop
      // and read back an email address. (bug 968259c4.)
      const { data } = await axios.get(`${API_URL}/github/account`, {
        headers: { 'x-agenfk-ui': '1' },
      });
      return data;
    } catch {
      // A server that is not running is not an account that is signed out, but
      // it is indistinguishable from here, and 'unreadable' is the honest one
      // of the three: it makes the screen say "could not check" rather than
      // sending the user off to re-authenticate something that is fine.
      return { connected: false, reason: 'unreadable' };
    }
  },
  /**
   * Log the GitHub CLI out.
   *
   * The custom header forces a CORS preflight, which the API's localhost-origin
   * allowlist gates — without it any page open on the machine could log the
   * user out of `gh`. Same guard as `triggerUpdate`. (bug 968259c4.)
   */
  signOutGitHub: async (): Promise<{ signedOut: boolean; error?: string }> => {
    const { data } = await axios.post(`${API_URL}/github/signout`, undefined, {
      headers: { 'x-agenfk-ui': '1' },
    });
    return data;
  },
  listGitHubIssues: async (projectId: string, params?: { state?: string; search?: string }): Promise<{ number: number; title: string; state: string; labels: string[]; url: string }[]> => {
    const { data } = await axios.get(`${API_URL}/github/issues`, { params: { projectId, ...params } });
    return data;
  },
  importGitHubIssues: async (projectId: string, items: { issueNumber: number; type: string }[]): Promise<{ imported: { issueNumber: number; itemId: string }[]; errors: string[] }> => {
    const { data } = await axios.post(`${API_URL}/github/import`, { projectId, items });
    return data;
  },
  getVersion: async (): Promise<{ version: string }> => {
    const { data } = await axios.get(`${API_URL}/version`);
    return data;
  },
  getLatestRelease: async () => {
    const { data } = await axios.get(`${API_URL}/releases/latest`);
    return data;
  },
  /**
   * The telemetry opt-in, read from the same place `agenfk config set
   * telemetry` writes it.
   *
   * Not stored in `/settings` with the other preferences, deliberately: the
   * CLI has always owned `~/.agenfk/config.json` and copying the flag into the
   * settings table would give one value two homes, so whichever the UI read,
   * the other would silently disagree.
   */
  getTelemetryConfig: async (): Promise<{ telemetryEnabled: boolean; installationId: string | null }> => {
    const { data } = await axios.get(`${API_URL}/api/telemetry/config`);
    return data;
  },
  /**
   * The read above is open; this write is not.
   *
   * Opting somebody IN to analytics is a privacy decision, and this API is
   * unauthenticated on loopback — so the same preflight-forcing header that
   * guards the update trigger guards this. (bug 968259c4.)
   */
  setTelemetryConfig: async (enabled: boolean): Promise<{ telemetryEnabled: boolean }> => {
    const { data } = await axios.put(
      `${API_URL}/api/telemetry/config`,
      { telemetryEnabled: enabled },
      { headers: { 'x-agenfk-ui': '1' } },
    );
    return data;
  },
  triggerUpdate: async (): Promise<{ jobId: string }> => {
    // The custom header forces a CORS preflight so the API's localhost-origin
    // allowlist gates this RCE-trigger route against malicious pages. (bug 968259c4.)
    const { data } = await axios.post(`${API_URL}/releases/update`, undefined, {
      headers: { 'x-agenfk-ui': '1' },
    });
    return data;
  },
  getUpdateStatus: async (jobId: string): Promise<{ status: 'running' | 'success' | 'error'; output: string; exitCode?: number }> => {
    const { data } = await axios.get(`${API_URL}/releases/update/${jobId}`);
    return data;
  },
  getReadme: async (): Promise<{ content: string }> => {
    const { data } = await axios.get(`${API_URL}/api/readme`);
    return data;
  },
  listFlows: async (): Promise<Flow[]> => {
    try {
      const { data } = await axios.get(`${API_URL}/flows`);
      return data;
    } catch (e) {
      console.error('API Error listing flows:', e);
      throw e;
    }
  },
  createFlow: async (flowData: Partial<Flow>): Promise<Flow> => {
    try {
      const { data } = await axios.post(`${API_URL}/flows`, flowData);
      return data;
    } catch (e) {
      console.error('API Error creating flow:', e);
      throw e;
    }
  },
  updateFlow: async (id: string, flowData: Partial<Flow>): Promise<Flow> => {
    try {
      const { data } = await axios.put(`${API_URL}/flows/${id}`, flowData);
      return data;
    } catch (e) {
      console.error('API Error updating flow', id, e);
      throw e;
    }
  },
  deleteFlow: async (id: string): Promise<void> => {
    try {
      await axios.delete(`${API_URL}/flows/${id}`);
    } catch (e) {
      console.error('API Error deleting flow', id, e);
      throw e;
    }
  },
  setProjectFlow: async (projectId: string, flowId: string | null): Promise<void> => {
    try {
      await axios.post(`${API_URL}/projects/${projectId}/flow`, { flowId });
    } catch (e) {
      console.error('API Error setting flow for project', projectId, e);
      throw e;
    }
  },
  getProjectFlow: async (projectId: string): Promise<Flow> => {
    try {
      const { data } = await axios.get(`${API_URL}/projects/${projectId}/flow`);
      return data;
    } catch (e) {
      console.error('API Error getting flow for project', projectId, e);
      throw e;
    }
  },
  getOrgAvailableFlows: async (): Promise<{ flows: Flow[]; defaultFlowId: string | null; hubEnabled: boolean }> => {
    try {
      const { data } = await axios.get(`${API_URL}/flows/org-available`);
      return data;
    } catch (e) {
      console.error('API Error listing org-available flows:', e);
      throw e;
    }
  },
  selectOrgFlow: async (projectId: string, flowId: string | null): Promise<void> => {
    try {
      await axios.post(`${API_URL}/projects/${projectId}/flow/select-org`, { flowId });
    } catch (e) {
      console.error('API Error selecting org flow for project', projectId, e);
      throw e;
    }
  },
  getDefaultFlow: async (): Promise<Flow> => {
    try {
      const { data } = await axios.get(`${API_URL}/flows/default`);
      return data;
    } catch (e) {
      console.error('API Error getting default flow:', e);
      throw e;
    }
  },
  browseRegistry: async (): Promise<RegistryFlow[]> => {
    try {
      const { data } = await axios.get(`${API_URL}/registry/flows`);
      return data;
    } catch (e) {
      console.error('API Error browsing flow registry:', e);
      throw e;
    }
  },
  installFromRegistry: async (filename: string): Promise<Flow> => {
    try {
      const { data } = await axios.post(`${API_URL}/registry/flows/install`, { filename });
      return data;
    } catch (e) {
      console.error('API Error installing flow from registry:', filename, e);
      throw e;
    }
  },
  publishToRegistry: async (flowId: string): Promise<{ url: string; kind: 'pr' | 'existing' | 'direct'; note?: string; repo?: string; version?: string }> => {
    try {
      const { data } = await axios.post(`${API_URL}/registry/flows/publish`, { flowId });
      return data;
    } catch (e) {
      console.error('API Error publishing flow to registry:', flowId, e);
      throw e;
    }
  },
};
