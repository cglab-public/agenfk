import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

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

  it('should list items with includeArchived=true', async () => {
    mockedAxios.get.mockResolvedValue({ data: [] });
    await api.listItems({ projectId: 'p1', includeArchived: true });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/items'),
      expect.objectContaining({ params: expect.objectContaining({ includeArchived: 'true' }) })
    );
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

  it('should get item', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: 'i1' } });
    const result = await api.getItem('i1');
    expect(result.id).toBe('i1');
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/items/i1'));
  });

  it('should create item', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'i2' } });
    const result = await api.createItem({ title: 'New' });
    expect(result.id).toBe('i2');
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/items'), { title: 'New' });
  });

  it('should bulk update items', async () => {
    mockedAxios.post.mockResolvedValue({ data: { updated: 1 } });
    const result = await api.bulkUpdateItems([{ id: 'i1', updates: { status: 'DONE' as any } }]);
    expect(result.updated).toBe(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/items/bulk'), expect.any(Object));
  });

  it('should delete project', async () => {
    mockedAxios.delete.mockResolvedValue({});
    await api.deleteProject('p1');
    expect(mockedAxios.delete).toHaveBeenCalledWith(expect.stringContaining('/projects/p1'));
  });

  it('should trash archived items', async () => {
    mockedAxios.post.mockResolvedValue({ data: { trashed: 2 } });
    const result = await api.trashArchivedItems('p1');
    expect(result.trashed).toBe(2);
  });

  it('should get jira status', async () => {
    mockedAxios.get.mockResolvedValue({ data: { configured: true, connected: true, cloudId: 'c1' } });
    const result = await api.getJiraStatus();
    expect(result.configured).toBe(true);
    expect(result.connected).toBe(true);
  });

  it('should return disconnected jira status on error', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network'));
    const result = await api.getJiraStatus();
    expect(result.configured).toBe(false);
    expect(result.connected).toBe(false);
  });

  it('should disconnect jira', async () => {
    mockedAxios.post.mockResolvedValue({});
    await api.disconnectJira();
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/jira/disconnect'));
  });

  it('should list jira projects', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: 'j1', key: 'JP', name: 'Jira' }] });
    const result = await api.listJiraProjects();
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('JP');
  });

  it('should list jira issues', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: 'j1', key: 'JP-1', summary: 'Issue 1' }] });
    const result = await api.listJiraIssues('JP', { summary: 'Issue' });
    expect(result).toHaveLength(1);
  });

  it('should import jira issues', async () => {
    mockedAxios.post.mockResolvedValue({});
    await api.importJiraIssues('p1', [{ issueKey: 'JP-1', type: 'TASK' }]);
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/jira/import'), expect.any(Object));
  });

  it('should get version', async () => {
    mockedAxios.get.mockResolvedValue({ data: { version: '1.0.0' } });
    const result = await api.getVersion();
    expect(result.version).toBe('1.0.0');
  });

  it('should get latest release', async () => {
    mockedAxios.get.mockResolvedValue({ data: { tag: 'v1.0.0' } });
    const result = await api.getLatestRelease();
    expect(result.tag).toBe('v1.0.0');
  });

  it('should trigger update', async () => {
    mockedAxios.post.mockResolvedValue({ data: { jobId: 'job-1' } });
    const result = await api.triggerUpdate();
    expect(result.jobId).toBe('job-1');
  });

  it('should get update status', async () => {
    mockedAxios.get.mockResolvedValue({ data: { status: 'success', output: 'done', exitCode: 0 } });
    const result = await api.getUpdateStatus('job-1');
    expect(result.status).toBe('success');
  });

  it('should get readme', async () => {
    mockedAxios.get.mockResolvedValue({ data: { content: '# README' } });
    const result = await api.getReadme();
    expect(result.content).toBe('# README');
  });

  describe('Error handling', () => {
    it('should handle listProjects error', async () => {
      mockedAxios.get.mockRejectedValue(new Error('API Error'));
      await expect(api.listProjects()).rejects.toThrow('API Error');
    });

    it('should handle getItem error', async () => {
      mockedAxios.get.mockRejectedValue(new Error('API Error'));
      await expect(api.getItem('i1')).rejects.toThrow('API Error');
    });

    it('should handle createItem error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));
      await expect(api.createItem({})).rejects.toThrow('API Error');
    });

    it('should handle updateItem error', async () => {
      mockedAxios.put.mockRejectedValue(new Error('API Error'));
      await expect(api.updateItem('i1', {})).rejects.toThrow('API Error');
    });

    it('should handle deleteItem error', async () => {
      mockedAxios.delete.mockRejectedValue(new Error('API Error'));
      await expect(api.deleteItem('i1')).rejects.toThrow('API Error');
    });

    it('should handle deleteProject error', async () => {
      mockedAxios.delete.mockRejectedValue(new Error('API Error'));
      await expect(api.deleteProject('p1')).rejects.toThrow('API Error');
    });

    it('should handle bulkUpdateItems error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));
      await expect(api.bulkUpdateItems([])).rejects.toThrow('API Error');
    });

    it('should handle trashArchivedItems error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));
      await expect(api.trashArchivedItems('p1')).rejects.toThrow('API Error');
    });

    it('should handle disconnectJira error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));
      await expect(api.disconnectJira()).rejects.toThrow('API Error');
    });

    it('should handle createProject error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));
      await expect(api.createProject({ name: 'P1' })).rejects.toThrow('API Error');
    });

    it('should handle listItems error', async () => {
      mockedAxios.get.mockRejectedValue(new Error('API Error'));
      await expect(api.listItems({ projectId: 'p1' })).rejects.toThrow('API Error');
    });
  });
});
