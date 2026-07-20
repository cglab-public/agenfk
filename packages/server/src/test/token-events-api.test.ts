import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';
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

const TEST_DB = path.resolve('./token-events-api-test-db.sqlite');

// The query_token_events MCP tool must actually be advertised by the live MCP
// server. The `agenfk tokens` CLI command is exercised behaviourally in the CLI
// package's own suite (running the built CLI), not by grepping cli/src/index.ts.
describe('query_token_events is exposed by the live MCP server', () => {
  let mcp: ConnectedMcpClient;
  let toolNames: string[];
  beforeAll(async () => {
    mcp = await connectMcpClient();
    toolNames = await listToolNames(mcp.client);
  });
  afterAll(async () => {
    await mcp.close();
  });
  it('exposes "query_token_events" via listTools', () => {
    expect(toolNames).toContain('query_token_events');
  });
});

describe('GET /token-events REST', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  beforeEach(async () => { await initStorage(); });

  it('returns an empty array when no events exist', async () => {
    const res = await request(app).get('/token-events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  it('filters by itemId, projectId, since, until, client, limit', async () => {
    const { storage } = await import('../server');
    await storage.insertTokenEvent({
      id: 'a', ts: '2026-05-10T00:00:00Z', client: 'codex', sessionId: 's',
      model: 'm', input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2,
      itemId: 'item-X', projectId: 'proj-1', sourcePath: '/p/a', sourceOffset: 0,
    });
    await storage.insertTokenEvent({
      id: 'b', ts: '2026-05-11T00:00:00Z', client: 'claude-code', sessionId: 's',
      model: 'm', input: 2, cachedInput: 0, output: 2, reasoning: 0, total: 4,
      itemId: 'item-X', projectId: 'proj-1', sourcePath: '/p/b', sourceOffset: 0,
    });
    // A different project/item so projectId + itemId filters are discriminating.
    await storage.insertTokenEvent({
      id: 'c', ts: '2026-05-12T00:00:00Z', client: 'codex', sessionId: 's',
      model: 'm', input: 3, cachedInput: 0, output: 3, reasoning: 0, total: 6,
      itemId: 'item-Y', projectId: 'proj-2', sourcePath: '/p/c', sourceOffset: 0,
    });

    const byItem = await request(app).get('/token-events').query({ itemId: 'item-X' });
    expect(byItem.status).toBe(200);
    expect(byItem.body.map((e: any) => e.id).sort()).toEqual(['a', 'b']);

    const byProject = await request(app).get('/token-events').query({ projectId: 'proj-1' });
    expect(byProject.body.map((e: any) => e.id).sort()).toEqual(['a', 'b']);

    const byClient = await request(app).get('/token-events').query({ client: 'codex' });
    expect(byClient.body.map((e: any) => e.id).sort()).toEqual(['a', 'c']);

    // since/until are inclusive/exclusive window filters on ts.
    const since = await request(app).get('/token-events').query({ since: '2026-05-11T00:00:00Z' });
    expect(since.body.map((e: any) => e.id).sort()).toEqual(['b', 'c']);

    const until = await request(app).get('/token-events').query({ until: '2026-05-10T12:00:00Z' });
    expect(until.body.map((e: any) => e.id)).toEqual(['a']);

    const limited = await request(app).get('/token-events').query({ limit: 1 });
    expect(limited.body).toHaveLength(1);
  });
});
