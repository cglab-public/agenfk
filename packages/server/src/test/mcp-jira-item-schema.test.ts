/**
 * `jiraItem` must be visible on the ADVERTISED MCP tool schema.
 *
 * The zod `CreateItemSchema`/`UpdateItemSchema` are server-side validation: they
 * decide what is accepted once a call arrives. What an MCP client can *send* is
 * decided by the `inputSchema` published in the ListTools response, and the two
 * are maintained separately. Adding the field to zod alone — which is what the
 * first attempt at this did — means the parameter exists but no agent ever
 * discovers it, so the CLI and MCP surfaces this repo documents as
 * interchangeable silently are not.
 *
 * Asserted through a real MCP client over the live ListTools handler, not by
 * reading the source.
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

describe('MCP advertises the JIRA linking parameter', () => {
  let mcp: ConnectedMcpClient;
  let tools: any[];

  beforeAll(async () => {
    mcp = await connectMcpClient();
    const listed: any = await mcp.client.listTools();
    tools = listed.tools;
  });

  afterAll(async () => {
    await mcp?.close?.();
  });

  const toolNamed = (name: string) => tools.find(t => t.name === name);

  it('create_item accepts jiraItem', () => {
    const props = toolNamed('create_item')?.inputSchema?.properties ?? {};
    expect(Object.keys(props)).toContain('jiraItem');
    expect(props.jiraItem.type).toBe('string');
  });

  it('update_item accepts jiraItem', () => {
    const props = toolNamed('update_item')?.inputSchema?.properties ?? {};
    expect(Object.keys(props)).toContain('jiraItem');
    expect(props.jiraItem.type).toBe('string');
  });

  it('does not make jiraItem required on either tool', () => {
    // Linking is optional; making it required would break every existing caller.
    expect(toolNamed('create_item')?.inputSchema?.required ?? []).not.toContain('jiraItem');
    expect(toolNamed('update_item')?.inputSchema?.required ?? []).not.toContain('jiraItem');
  });

  it("tells the agent how to unlink, since 'none' is not guessable", () => {
    const description = toolNamed('update_item')?.inputSchema?.properties?.jiraItem?.description ?? '';
    // Stronger than a bare substring match: the description has to actually
    // instruct, not merely contain the word somewhere.
    expect(description).toMatch(/['"`]?none['"`]? to unlink/i);
  });

  // Advertising the parameter is only half of it — the handler has to FORWARD
  // it. Both handlers currently spread the parsed args into the REST call, but a
  // refactor to an explicit field list would drop jiraItem with every schema
  // assertion above still green.
  describe('the handlers forward it to the REST route', () => {
    it('create_item sends jiraItem onward', async () => {
      const axiosMock: any = (await import('axios')).default;
      axiosMock.post.mockResolvedValue({ data: { id: 'i1', title: 'T' } });

      await mcp.client.callTool({
        name: 'create_item',
        arguments: { projectId: 'p1', type: 'TASK', title: 'T', jiraItem: 'CGLAB-163' },
      });

      const call = axiosMock.post.mock.calls.find((c: any[]) => String(c[0]).includes('/items'));
      expect(call?.[1]).toEqual(expect.objectContaining({ jiraItem: 'CGLAB-163' }));
    });

    it('update_item sends jiraItem onward', async () => {
      const axiosMock: any = (await import('axios')).default;
      axiosMock.get.mockResolvedValue({ data: { id: 'i1', status: 'TODO' } });
      axiosMock.put.mockResolvedValue({ data: { id: 'i1', title: 'T' } });

      await mcp.client.callTool({
        name: 'update_item',
        arguments: { id: 'i1', jiraItem: 'none' },
      });

      const call = axiosMock.put.mock.calls.find((c: any[]) => String(c[0]).includes('/items/'));
      expect(call?.[1]).toEqual(expect.objectContaining({ jiraItem: 'none' }));
    });
  });
});
