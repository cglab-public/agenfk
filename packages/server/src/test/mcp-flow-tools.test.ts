/**
 * MCP flow management tools are exposed by the live MCP server:
 *   list_flows, delete_flow, use_flow
 *
 * A real MCP client is connected to the server and each tool must be advertised
 * by the live ListTools handler. create_flow and update_flow are pinned, with
 * their schemas, in mcp-flow-contract-fields.test.ts; the REST routes these
 * tools delegate to are pinned in server.supplemental.test.ts (/flows,
 * /projects/:id/flow), flow-step-validation.test.ts and flow-checks-save.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectMcpClient, listToolNames, type ConnectedMcpClient } from './helpers/mcpClient';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.interceptors = {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  };
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

describe('MCP flow tools are exposed by the live MCP server', () => {
  let mcp: ConnectedMcpClient;
  let toolNames: string[];

  beforeAll(async () => {
    mcp = await connectMcpClient();
    toolNames = await listToolNames(mcp.client);
  });

  afterAll(async () => {
    await mcp.close();
  });

  const TOOLS = ['list_flows', 'delete_flow', 'use_flow'];

  for (const tool of TOOLS) {
    it(`exposes "${tool}" via listTools`, () => {
      expect(toolNames).toContain(tool);
    });
  }
});
