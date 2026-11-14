/**
 * @file CGLAB-457 — the MCP surface for the review brief, and a review record
 * whose range is left to the server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectMcpClient, type ConnectedMcpClient } from './helpers/mcpClient';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.interceptors = { request: { use: vi.fn() }, response: { use: vi.fn() } };
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

describe('CGLAB-457 MCP review tools', () => {
  let mcp: ConnectedMcpClient;
  let tools: Array<{ name: string; inputSchema: any }>;
  beforeAll(async () => { mcp = await connectMcpClient(); tools = (await mcp.client.listTools()).tools as any; });
  afterAll(async () => { await mcp.close(); });

  it('exposes review_brief, taking only the card id', () => {
    const t = tools.find(x => x.name === 'review_brief');
    expect(t).toBeDefined();
    expect(t!.inputSchema.required).toEqual(['itemId']);
  });

  it("record_review no longer requires a range: the server works it out", () => {
    const t = tools.find(x => x.name === 'record_review')!;
    expect(t.inputSchema.required).not.toContain('range');
    expect(t.inputSchema.properties.range.description).toMatch(/auto/);
  });
});
