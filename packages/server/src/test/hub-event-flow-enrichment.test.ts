/**
 * Hub events must carry `flow: { name, install_source }` in their payload
 * whenever a projectId is known, so the hub admin can see at a glance which flow
 * was active and whether the install is hub-managed or manual.
 *
 * Behaviour-based: enable the hub outbox, trigger a real hub event that carries a
 * projectId (POST /prs → pr.opened), and assert the enriched payload that lands
 * in hub_outbox — instead of grepping server.ts for resolveFlowName /
 * getInstallSource.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});

import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. The
 * churn produced `Error: Parse Error: Expected HTTP/` — a transport failure
 * that hands the test an empty body, so one bad socket surfaces as a confident
 * wrong assertion in whichever test happened to be running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./hub-flow-enrichment-test-db.sqlite');

// recordHubEvent enqueues into hub_outbox without awaiting the HTTP response, and
// awaits a flow-name lookup before inserting — so poll rather than read once.
async function waitForOutboxPayload(predicate: (p: any) => boolean, timeoutMs = 5000): Promise<any> {
  const db: any = (await import('../server')).storage['database'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[];
    const found = rows.map((r) => JSON.parse(r.payload)).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('hub events are enriched with flow { name, install_source }', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('a projectId-bearing event (pr.opened) carries flow.name + flow.install_source', async () => {
    const project = (await agent().post('/projects').send({ name: 'FlowEnrich' })).body;
    const item = (await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;

    const res = await agent().post('/prs').send({
      itemId: item.id, prNumber: 8801, repo: 'org/enrich',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(201);

    const event = await waitForOutboxPayload((p: any) => p.type === 'pr.opened' && p.payload?.prNumber === 8801);
    expect(event).toBeDefined();
    // The enrichment: a flow envelope with a resolved name and the install source.
    expect(event.payload.flow).toBeDefined();
    expect(typeof event.payload.flow.name).toBe('string');
    expect(event.payload.flow.name.length).toBeGreaterThan(0);
    expect(typeof event.payload.flow.install_source).toBe('string');
  });
});
