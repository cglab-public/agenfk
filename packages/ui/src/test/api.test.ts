import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('UI API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list projects', async () => {
    mockedAxios.get.mockResolvedValue({ data: [] });
    const result = await api.listProjects();
    expect(result).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/projects'));
  });

  it('should create project', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'p1' } });
    const result = await api.createProject({ name: 'P1' });
    expect(result.id).toBe('p1');
  });

  it('should list items', async () => {
    mockedAxios.get.mockResolvedValue({ data: [] });
    await api.listItems({ projectId: 'p1' });
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/items'), expect.any(Object));
  });

  it('should update item', async () => {
    mockedAxios.put.mockResolvedValue({ data: {} });
    await api.updateItem('i1', { status: 'DONE' } as any);
    expect(mockedAxios.put).toHaveBeenCalledWith(expect.stringContaining('/items/i1'), { status: 'DONE' });
  });

  it('should delete item', async () => {
    mockedAxios.delete.mockResolvedValue({});
    await api.deleteItem('i1');
    expect(mockedAxios.delete).toHaveBeenCalledWith(expect.stringContaining('/items/i1'));
  });
});
