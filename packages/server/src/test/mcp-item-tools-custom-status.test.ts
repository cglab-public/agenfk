/**
 * The MCP item tools take any flow step name as a status (GH-281).
 *
 * list_items, create_item and update_item once declared `status` as a fixed
 * enum of the default flow's steps, so a card on a custom-flow step (DISCOVERY,
 * CREATE_UNIT_TESTS) could not be created, moved back or listed through MCP, and
 * list_items required a status, so there was no "everything in flight" sweep.
 * The guard on that used to grep index.ts; this drives the tools through a real
 * MCP client against a mocked REST API instead.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { connectMcpClient, type ConnectedMcpClient } from './helpers/mcpClient';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.put = vi.fn();
  mockAxios.delete = vi.fn();
  mockAxios.interceptors = { request: { use: vi.fn() }, response: { use: vi.fn() } };
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const axiosMock = async () => ((await import('axios')).default as any);
const text = (r: any) => String(r?.content?.[0]?.text ?? '');

describe('MCP item tools on a custom flow', () => {
  let mcp: ConnectedMcpClient;
  beforeAll(async () => { mcp = await connectMcpClient(); });
  afterAll(async () => { await mcp?.close?.(); });
  beforeEach(async () => {
    const a = await axiosMock();
    a.get.mockReset(); a.post.mockReset(); a.put.mockReset();
  });

  it('create_item accepts a custom-flow step as the status and passes it on', async () => {
    const a = await axiosMock();
    a.post.mockResolvedValue({ status: 201, data: { id: 'i1', status: 'DISCOVERY' } });
    const res: any = await mcp.client.callTool({ name: 'create_item', arguments: { projectId: 'p1', type: 'TASK', title: 't', status: 'DISCOVERY' } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(a.post).toHaveBeenCalledWith('/items', expect.objectContaining({ status: 'DISCOVERY' }));
  });

  it('update_item accepts a custom-flow step as the status and passes it on', async () => {
    const a = await axiosMock();
    a.get.mockResolvedValue({ status: 200, data: { id: 'i1', status: 'IN_PROGRESS' } });
    a.put.mockResolvedValue({ status: 200, data: { id: 'i1', status: 'CREATE_UNIT_TESTS' } });
    const res: any = await mcp.client.callTool({ name: 'update_item', arguments: { id: 'i1', status: 'CREATE_UNIT_TESTS' } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(a.put).toHaveBeenCalledWith('/items/i1', expect.objectContaining({ status: 'CREATE_UNIT_TESTS' }));
  });

  it('list_items filters by a custom-flow step', async () => {
    const a = await axiosMock();
    a.get.mockResolvedValue({ status: 200, data: [{ id: 'i1', type: 'TASK', title: 't', status: 'DISCOVERY' }] });
    const res: any = await mcp.client.callTool({ name: 'list_items', arguments: { projectId: 'p1', status: 'DISCOVERY' } });
    expect(res.isError, text(res)).toBeFalsy();
    const call = a.get.mock.calls.find((c: any[]) => c[0] === '/items');
    expect(call?.[1]?.params).toMatchObject({ projectId: 'p1', status: 'DISCOVERY' });
    expect(text(res)).toContain('DISCOVERY');
  });

  it('list_items with no status sweeps every step', async () => {
    const a = await axiosMock();
    a.get.mockResolvedValue({ status: 200, data: [] });
    const res: any = await mcp.client.callTool({ name: 'list_items', arguments: { projectId: 'p1' } });
    expect(res.isError, text(res)).toBeFalsy();
    const call = a.get.mock.calls.find((c: any[]) => c[0] === '/items');
    expect(call?.[1]?.params).toEqual({ projectId: 'p1' });
  });

  it('advertises status as a free step name, required on none of the three', async () => {
    const { tools } = await mcp.client.listTools();
    for (const name of ['list_items', 'create_item', 'update_item']) {
      const tool: any = tools.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.inputSchema.properties.status.type, name).toBe('string');
      expect(tool.inputSchema.properties.status.enum, name).toBeUndefined();
      expect(tool.inputSchema.required ?? [], name).not.toContain('status');
    }
  });
});
