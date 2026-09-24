/**
 * @file CGLAB-381 (S5-T1) — the MCP surface exposes the review record, so an
 * MCP-mode client can record an independent review without the CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectMcpClient, listToolNames, type ConnectedMcpClient } from './helpers/mcpClient';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.interceptors = { request: { use: vi.fn() }, response: { use: vi.fn() } };
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

describe('record_review MCP tool', () => {
  let mcp: ConnectedMcpClient;
  let toolNames: string[];
  beforeAll(async () => { mcp = await connectMcpClient(); toolNames = await listToolNames(mcp.client); });
  afterAll(async () => { await mcp.close(); });

  it('is exposed by the live MCP server', () => {
    expect(toolNames).toContain('record_review');
  });
});
