/**
 * MCP get_item leaves step records out unless asked (TASK a5f09e66, BUG
 * ec325925): one card's records came back at 11 MB, past what an MCP result
 * may hold, so the agent could not read its own card. includeRecords asks for
 * them. Asserted through a real MCP client against a mocked REST API.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

describe('get_item and step records', () => {
  let mcp: ConnectedMcpClient;
  let tools: any[];
  beforeAll(async () => { mcp = await connectMcpClient(); tools = ((await mcp.client.listTools()) as any).tools; });
  afterAll(async () => { await mcp?.close?.(); });

  const axiosGet = async () => ((await import('axios')).default as any).get as ReturnType<typeof vi.fn>;
  // The call for the card itself (an upgrade check may GET other URLs too).
  const itemCall = (get: ReturnType<typeof vi.fn>) => get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/items/')).at(-1);

  it('advertises includeRecords, optional, as a boolean', () => {
    const tool = tools.find(t => t.name === 'get_item');
    expect(tool?.inputSchema?.properties?.includeRecords?.type).toBe('boolean');
    expect(tool.inputSchema.required ?? []).not.toContain('includeRecords');
  });

  it('asks the server for the card without its records by default', async () => {
    const get = await axiosGet();
    get.mockResolvedValue({ status: 200, data: { id: 'i1', title: 't' } });
    await mcp.client.callTool({ name: 'get_item', arguments: { id: 'i1' } });
    expect(itemCall(get)).toBe('/items/i1');
  });

  it('asks for the records when includeRecords is true', async () => {
    const get = await axiosGet();
    get.mockResolvedValue({ status: 200, data: { id: 'i1', title: 't', stepRecords: [] } });
    await mcp.client.callTool({ name: 'get_item', arguments: { id: 'i1', includeRecords: true } });
    expect(itemCall(get)).toBe('/items/i1?records=1');
  });
});
