import axios from 'axios';
import { AgenFKItem, ItemType, Status, Flow } from './types'; // We need to copy types or import from core if possible, but symlinking in Vite monorepo can be tricky without proper setup.
// For MVP, we'll duplicate the types interface or use `any`.
// Better: configure vite to aliase @agenfk/core to the local package.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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
  createItem: async (item: Partial<AgenFKItem>) => {
    try {
      const { data } = await axios.post(`${API_URL}/items`, item);
      return data;
    } catch (e) {
      console.error("API Error creating item:", e);
      throw e;
    }
  },
  updateItem: async (id: string, updates: Partial<AgenFKItem>) => {
    try {
      const { data } = await axios.put(`${API_URL}/items/${id}`, updates);
      return data;
    } catch (e) {
      console.error(`API Error updating item ${id}:`, e);
      throw e;
    }
  },
  bulkUpdateItems: async (items: { id: string; updates: Partial<AgenFKItem> }[]) => {
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
  moveItem: async (id: string, targetProjectId: string): Promise<{ item: AgenFKItem; movedCount: number }> => {
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
    const { data } = await axios.post(`${API_URL}/releases/update`);
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
};
