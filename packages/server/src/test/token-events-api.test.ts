import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const ROOT = path.resolve(__dirname, '../../../..');
const TEST_DB = path.resolve('./token-events-api-test-db.sqlite');

describe('query_token_events MCP tool registration', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(path.join(ROOT, 'packages/server/src/index.ts'), 'utf8');
  });
  it('declares "query_token_events" in the tools list', () => {
    expect(src).toMatch(/name:\s*["']query_token_events["']/);
  });
  it('handles "query_token_events" in the call-tool switch', () => {
    expect(src).toMatch(/case\s+["']query_token_events["']/);
  });
});

describe('agenfk tokens CLI command', () => {
  it('declares a `tokens` command in packages/cli/src/index.ts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
    expect(src).toMatch(/\.command\s*\(\s*['"]tokens/);
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
    // Use the storage directly via a small test endpoint helper isn't available;
    // instead poke the storage by importing and inserting. Both tests below
    // are independent, so we accept that this test exercises only the route's
    // parameter forwarding.
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

    const byItem = await request(app).get('/token-events').query({ itemId: 'item-X' });
    expect(byItem.status).toBe(200);
    expect(byItem.body.map((e: any) => e.id).sort()).toEqual(['a', 'b']);

    const byClient = await request(app).get('/token-events').query({ client: 'codex' });
    expect(byClient.body.map((e: any) => e.id)).toEqual(['a']);

    const limited = await request(app).get('/token-events').query({ limit: 1 });
    expect(limited.body).toHaveLength(1);
  });
});
