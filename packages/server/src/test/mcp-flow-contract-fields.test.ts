/**
 * CGLAB-385 (S9 review) — the MCP create_flow / update_flow tools carry a
 * step's contract (role, checks, the commit flags) and its cosmetics.
 *
 * zod strips keys a schema does not name, so a flow created over MCP lost its
 * roles and checks before the REST route ever saw them, while the same flow
 * sent with the CLI kept them. Asserted on the live ListTools schema AND on
 * what each handler forwards.
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

const FIELDS = ['role', 'checks', 'autoCommit', 'requireCommit', 'color', 'icon'];
const step = { id: 's1', name: 'BUILD', order: 1, role: 'coding', checks: [{ id: 'jira-key-valid', params: { x: '1' } }], autoCommit: true, requireCommit: true, color: '#123456', icon: 'code' };

describe('MCP flow tools carry the step contract', () => {
  let mcp: ConnectedMcpClient;
  let tools: any[];
  let axiosMock: any;

  beforeAll(async () => {
    mcp = await connectMcpClient();
    tools = ((await mcp.client.listTools()) as any).tools;
    axiosMock = (await import('axios')).default;
  });
  afterAll(async () => { await mcp?.close?.(); });
  beforeEach(() => { axiosMock.post.mockReset(); axiosMock.put.mockReset(); });

  for (const tool of ['create_flow', 'update_flow']) {
    it(`${tool} advertises ${FIELDS.join(', ')} and a step id on each step`, () => {
      const props = tools.find(t => t.name === tool)?.inputSchema?.properties?.steps?.items?.properties ?? {};
      for (const f of [...FIELDS, 'id']) expect(Object.keys(props), f).toContain(f);
    });
  }

  it('create_flow and update_flow advertise and forward the flow-level verifyAt (281adef0)', async () => {
    for (const tool of ['create_flow', 'update_flow']) {
      expect(Object.keys(tools.find(t => t.name === tool)?.inputSchema?.properties ?? {}), tool).toContain('verifyAt');
    }
    axiosMock.post.mockResolvedValue({ data: { id: 'f1', name: 'F' } });
    await mcp.client.callTool({ name: 'create_flow', arguments: { name: 'F', steps: [step], verifyAt: 'parent' } });
    expect(axiosMock.post.mock.calls.find(([u]: [string]) => u === '/flows')[1].verifyAt).toBe('parent');
    axiosMock.put.mockResolvedValue({ data: { id: 'f1', name: 'F' } });
    await mcp.client.callTool({ name: 'update_flow', arguments: { id: 'f1', verifyAt: 'leaf' } });
    expect(axiosMock.put.mock.calls[0][1].verifyAt).toBe('leaf');
  });

  it('create_flow forwards them to POST /flows', async () => {
    axiosMock.post.mockResolvedValue({ data: { id: 'f1', name: 'F' } });
    await mcp.client.callTool({ name: 'create_flow', arguments: { name: 'F', steps: [step] } });
    const [, body] = axiosMock.post.mock.calls.find(([u]: [string]) => u === '/flows');
    expect(body.steps[0]).toEqual(step);
  });

  it('update_flow forwards them, and an explicit null role or [] checks (which clear), to PUT /flows/:id', async () => {
    axiosMock.put.mockResolvedValue({ data: { id: 'f1', name: 'F' } });
    await mcp.client.callTool({ name: 'update_flow', arguments: { id: 'f1', steps: [step, { name: 'OTHER', order: 2, role: null, checks: [] }] } });
    const [url, body] = axiosMock.put.mock.calls[0];
    expect(url).toBe('/flows/f1');
    expect(body.steps[0]).toEqual(step);
    expect(body.steps[1]).toMatchObject({ role: null, checks: [] });
  });
});
