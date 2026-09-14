import axios from 'axios';
import { AgEnFKItem, ItemType, Status, Flow, RegistryFlow } from './types'; // We need to copy types or import from core if possible, but symlinking in Vite monorepo can be tricky without proper setup.
import { API_URL } from './apiUrl';
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
  /** The card's title, so a restored tab has a name and not a uuid. */
  itemTitle?: string;
  openedAt: string;
}

export interface AppSettingsDto {
  tmuxByDefault: boolean;
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
      console.error(`API Error listing agent runs for ${itemId}:`, e);
      throw e;
    }
  },
  listRunEvents: async (runId: string) => {
    try {
      const { data } = await axios.get(`${API_URL}/agent-runs/${runId}/events`);
      return data;
    } catch (e) {
      console.error(`API Error listing run events for ${runId}:`, e);
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
      console.error(`API Error deleting project ${id}:`, e);
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
      console.error(`API Error getting item ${id}:`, e);
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
   * Terminals to put back, and the conversations they held.
   *
   * The server filters out sessions whose card is gone or trashed, so what
   * comes back here is what can actually be opened.
   */
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
      console.error(`API Error forgetting terminal session ${id}:`, e);
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
      const { data } = await axios.put(`${API_URL}/items/${id}`, updates);
      return data;
    } catch (e) {
      console.error(`API Error updating item ${id}:`, e);
      throw e;
    }
  },
  bulkUpdateItems: async (items: { id: string; updates: Partial<AgEnFKItem> }[]) => {
    try {
      const { data } = await axios.post(`${API_URL}/items/bulk`, { items });
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
      console.error(`API Error deleting item ${id}:`, e);
      throw e;
    }
  },
  moveItem: async (id: string, targetProjectId: string): Promise<{ item: AgEnFKItem; movedCount: number }> => {
    try {
      const { data } = await axios.post(`${API_URL}/items/${id}/move`, { targetProjectId });
      return data;
    } catch (e) {
      console.error(`API Error moving item ${id} to project ${targetProjectId}:`, e);
      throw e;
    }
  },
  trashArchivedItems: async (projectId: string) => {
    try {
      const { data } = await axios.post(`${API_URL}/items/trash-archived`, { projectId });
      return data;
    } catch (e) {
      console.error(`API Error trashing archived items for project ${projectId}:`, e);
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
      console.error(`API Error updating flow ${id}:`, e);
      throw e;
    }
  },
  deleteFlow: async (id: string): Promise<void> => {
    try {
      await axios.delete(`${API_URL}/flows/${id}`);
    } catch (e) {
      console.error(`API Error deleting flow ${id}:`, e);
      throw e;
    }
  },
  setProjectFlow: async (projectId: string, flowId: string | null): Promise<void> => {
    try {
      await axios.post(`${API_URL}/projects/${projectId}/flow`, { flowId });
    } catch (e) {
      console.error(`API Error setting flow for project ${projectId}:`, e);
      throw e;
    }
  },
  getProjectFlow: async (projectId: string): Promise<Flow> => {
    try {
      const { data } = await axios.get(`${API_URL}/projects/${projectId}/flow`);
      return data;
    } catch (e) {
      console.error(`API Error getting flow for project ${projectId}:`, e);
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
      console.error(`API Error selecting org flow for project ${projectId}:`, e);
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
      console.error(`API Error installing flow from registry (${filename}):`, e);
      throw e;
    }
  },
  publishToRegistry: async (flowId: string): Promise<{ url: string; kind: 'pr' | 'existing'; note?: string }> => {
    try {
      const { data } = await axios.post(`${API_URL}/registry/flows/publish`, { flowId });
      return data;
    } catch (e) {
      console.error(`API Error publishing flow ${flowId} to registry:`, e);
      throw e;
    }
  },
};
