import axios from 'axios';
import { AgenticItem, ItemType, Status } from './types'; // We need to copy types or import from core if possible, but symlinking in Vite monorepo can be tricky without proper setup.
// For MVP, we'll duplicate the types interface or use `any`.
// Better: configure vite to aliase @agentic/core to the local package.

const API_URL = 'http://localhost:3000';

export const api = {
  listItems: async (params?: { type?: string; status?: string; parentId?: string }) => {
    try {
      const { data } = await axios.get(`${API_URL}/items`, { params });
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
  createItem: async (item: Partial<AgenticItem>) => {
    try {
      const { data } = await axios.post(`${API_URL}/items`, item);
      return data;
    } catch (e) {
      console.error("API Error creating item:", e);
      throw e;
    }
  },
  updateItem: async (id: string, updates: Partial<AgenticItem>) => {
    try {
      const { data } = await axios.put(`${API_URL}/items/${id}`, updates);
      return data;
    } catch (e) {
      console.error(`API Error updating item ${id}:`, e);
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
  }
};
