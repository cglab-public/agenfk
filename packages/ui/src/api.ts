import axios from 'axios';
import { AgenFKItem, ItemType, Status } from './types'; // We need to copy types or import from core if possible, but symlinking in Vite monorepo can be tricky without proper setup.
// For MVP, we'll duplicate the types interface or use `any`.
// Better: configure vite to aliase @agenfk/core to the local package.

const API_URL = 'http://localhost:3000';

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
  getJiraStatus: async (): Promise<{ configured: boolean; connected: boolean; cloudId?: string; email?: string; message?: string }> => {
    try {
      const { data } = await axios.get(`${API_URL}/jira/status`);
      return data;
    } catch {
      return { configured: false, connected: false };
    }
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
  importJiraIssues: async (projectId: string, issueKeys: string[]): Promise<void> => {
    await axios.post(`${API_URL}/jira/import`, { projectId, items: issueKeys.map(k => ({ issueKey: k })) });
  },
};
