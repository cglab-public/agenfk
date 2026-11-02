/**
 * The Airlock MCP surface (GH-294, T2): two read-only tools and no write tool.
 * The MCP process holds the agent's token, and the agent must never be handed
 * a way to change its own policy, so there is deliberately nothing to call.
 * Asserted through a real MCP client against a mocked REST API.
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

describe('Airlock MCP tools', () => {
  let mcp: ConnectedMcpClient;
  let tools: any[];
  beforeAll(async () => { mcp = await connectMcpClient(); tools = ((await mcp.client.listTools()) as any).tools; });
  afterAll(async () => { await mcp?.close?.(); });

  const mocked = async () => (await import('axios')).default as any;
  const textOf = (r: any) => (r.content as any[]).map(c => c.text).join('\n');

  it('exposes airlock_status and airlock_check', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('airlock_status');
    expect(names).toContain('airlock_check');
  });

  it('no MCP tool writes the policy', () => {
    const writers = tools.map(t => t.name as string).filter(n => /airlock.*(set|update|put|write|edit|grant|approve)/i.test(n));
    expect(writers).toEqual([]);
  });

  it('airlock_status mirrors GET /airlock/policy', async () => {
    const ax = await mocked();
    const body = { effective: { mode: 'observe' }, source: 'local', revision: 3, hubManaged: false, local: null, hub: null };
    ax.get.mockResolvedValue({ status: 200, data: body });
    const res = await mcp.client.callTool({ name: 'airlock_status', arguments: {} });
    const call = ax.get.mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => u.startsWith('/airlock')).at(-1);
    expect(call).toBe('/airlock/policy');
    expect(JSON.parse(textOf(res))).toEqual(body);
  });

  it('airlock_check asks the server for a dry-run verdict and never writes', async () => {
    const ax = await mocked();
    ax.post.mockClear();
    ax.put.mockClear();
    ax.post.mockResolvedValue({ status: 200, data: { verdict: { decision: 'deny', rule: 'builtin-metadata-deny', reason: 'metadata' }, mode: 'enforce', applies: true, revision: 2 } });
    const res = await mcp.client.callTool({
      name: 'airlock_check',
      arguments: { client: 'pi', model: 'cloudflare/glm', command: 'curl http://169.254.169.254/' },
    });
    expect(ax.post).toHaveBeenCalledTimes(1);
    const [url, body] = ax.post.mock.calls[0];
    expect(url).toBe('/airlock/evaluate');
    expect(body).toMatchObject({ client: 'pi', model: 'cloudflare/glm', dryRun: true, args: { command: 'curl http://169.254.169.254/' } });
    expect(ax.put).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('deny');
  });

  it('airlock_check needs a client and at least one of command, path or url', () => {
    const t = tools.find(x => x.name === 'airlock_check');
    expect(t.inputSchema.required).toContain('client');
    expect(Object.keys(t.inputSchema.properties)).toEqual(expect.arrayContaining(['client', 'model', 'command', 'path', 'url']));
  });
});
