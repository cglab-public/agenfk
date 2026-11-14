/**
 * efcacdeb (C3): MCP agents report agent checks through validate_progress.
 * The tool must advertise agentChecks, and its handler must forward it to the
 * REST verify - asserted through a real MCP client, not the source.
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

describe('validate_progress carries agent-check reports', () => {
  let mcp: ConnectedMcpClient;
  let tools: any[];
  beforeAll(async () => { mcp = await connectMcpClient(); tools = ((await mcp.client.listTools()) as any).tools; });
  afterAll(async () => { await mcp?.close?.(); });

  it('advertises agentChecks, optional, as a list of { name, outcome: pass|fail, note }', () => {
    const tool = tools.find(t => t.name === 'validate_progress');
    const p = tool?.inputSchema?.properties?.agentChecks;
    expect(p?.type).toBe('array');
    expect(p.items.properties.outcome.enum).toEqual(['pass', 'fail']);
    expect(tool.inputSchema.required ?? []).not.toContain('agentChecks');
  });

  it('forwards the reports to the verify route', async () => {
    const axiosMock: any = (await import('axios')).default;
    axiosMock.post.mockResolvedValue({ status: 200, data: { message: 'ok' } });
    await mcp.client.callTool({ name: 'validate_progress', arguments: { itemId: 'i1', evidence: 'e', agentChecks: [{ name: 'docs', outcome: 'pass', note: 'README updated' }] } });
    const call = axiosMock.post.mock.calls.find((c: any[]) => String(c[0]).includes('/validate'));
    expect(call?.[1]).toEqual(expect.objectContaining({ agentChecks: [{ name: 'docs', outcome: 'pass', note: 'README updated' }] }));
  });
});
