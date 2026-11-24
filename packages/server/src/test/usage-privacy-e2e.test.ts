/**
 * GH-389, end to end through the server's own ingestion wiring: a real Claude
 * Code session log is ingested and its usage counted on the card, and what is
 * queued for the hub carries the step totals only - never a per-turn event,
 * the session id, a message id or the log's path (review finding: the earlier
 * privacy test inserted turns straight into storage and never ran ingestion).
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});
vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('usage-privacy-e2e-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { echoRepo, A } from './helpers/echoRepo';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('usage through real ingestion', () => {
  it('counts a session log on the card and sends the hub totals only', async () => {
    const dir = echoRepo(A, 'agenfk-usage-e2e-');
    dirs.push(dir);
    const p = await agent().post('/projects').send({ name: 'usage-e2e' });
    await storage.updateProject(p.body.id, { projectRoot: dir, verifyCommand: 'exit 0' } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: 'usage-e2e', projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'IN_PROGRESS' } as any);

    const session = 'e2e-sess-7f3a';
    const r = await agent().post('/session-cards').set({ 'x-agenfk-internal': VERIFY_TOKEN! })
      .send({ client: 'claude-code', sessionId: session, itemId: c.body.id });
    expect(r.status).toBe(204);

    // The worker's sandboxed HOME, which is where the server's sources point.
    const logDir = path.join(os.homedir(), '.claude', 'projects', '-e2e-repo');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${session}.jsonl`);
    const turn = (id: string, input: number) => JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(), sessionId: session, cwd: dir, requestId: `req-${id}`,
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 } },
    });
    // Two content-block lines of one message, then a second message.
    fs.writeFileSync(logPath, [turn('msg_e2e_1', 40), turn('msg_e2e_1', 40), turn('msg_e2e_2', 2), ''].join('\n'));

    const res = await agent().post(`/items/${c.body.id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const card = (await agent().get(`/items/${c.body.id}`)).body;
    expect(card.usageByStep[0].total).toMatchObject({ turns: 2, input: 42, cacheRead: 200, cacheWrite: 20, output: 10 });

    const db: any = (storage as any)['database'];
    const deadline = Date.now() + 5000;
    let queued: string[] = [];
    while (Date.now() < deadline) {
      queued = (db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[]).map(row => row.payload);
      if (queued.some(q => q.includes('step.transitioned') && q.includes(c.body.id))) break;
      await new Promise(rs => setTimeout(rs, 25));
    }
    const types = queued.map(q => JSON.parse(q).type);
    expect(types).toContain('step.transitioned');
    expect(types).not.toContain('tokens.logged');
    for (const q of queued) {
      expect(q).not.toContain(session);
      expect(q).not.toContain('msg_e2e_1');
      expect(q).not.toContain(logPath);
    }
  });
});
