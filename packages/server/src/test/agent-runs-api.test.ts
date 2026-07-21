/**
 * REST surface for agent runs (CGLAB-18a). Behaviour-based: drives the real
 * Express app + storage against a temp DB via supertest.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./agent-runs-api-test-db.sqlite');

describe('agent-runs REST', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => { await initStorage(); });

  it('registers a run and lists it for the item', async () => {
    const create = await request(app).post('/agent-runs').send({
      itemId: 'item-X', projectId: 'p1', step: 'CREATE_UNIT_TESTS',
      actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', sessionId: 'sess-1',
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();
    expect(create.body.status).toBe('running');

    const list = await request(app).get('/items/item-X/agent-runs');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].sessionId).toBe('sess-1');
  });

  it('rejects an invalid actor and a missing itemId', async () => {
    expect((await request(app).post('/agent-runs').send({ itemId: 'i', step: 's', actor: 'nope' })).status).toBe(400);
    expect((await request(app).post('/agent-runs').send({ step: 's' })).status).toBe(400);
  });

  it('appends events with auto-incrementing seq and lists them ordered', async () => {
    const run = (await request(app).post('/agent-runs').send({ itemId: 'i2', step: 'IN_PROGRESS' })).body;
    await request(app).post(`/agent-runs/${run.id}/events`).send({ lane: 'orchestrator', kind: 'dispatch', text: 'go' });
    await request(app).post(`/agent-runs/${run.id}/events`).send({ lane: 'worker', kind: 'tool', tool: 'bash', text: 'npx vitest' });
    const res = await request(app).post(`/agent-runs/${run.id}/events`).send({ lane: 'worker', kind: 'result', text: '3 passed' });
    expect(res.status).toBe(201);

    const events = await request(app).get(`/agent-runs/${run.id}/events`);
    expect(events.body.map((e: any) => e.seq)).toEqual([0, 1, 2]);
    expect(events.body.map((e: any) => e.kind)).toEqual(['dispatch', 'tool', 'result']);
  });

  it('serializes an object payload to JSON', async () => {
    const run = (await request(app).post('/agent-runs').send({ itemId: 'i3', step: 's' })).body;
    await request(app).post(`/agent-runs/${run.id}/events`).send({ kind: 'diff', payload: { added: 14, removed: 2 } });
    const events = (await request(app).get(`/agent-runs/${run.id}/events`)).body;
    expect(JSON.parse(events[0].payload)).toEqual({ added: 14, removed: 2 });
  });

  it('rejects an invalid event kind', async () => {
    const run = (await request(app).post('/agent-runs').send({ itemId: 'i4', step: 's' })).body;
    const res = await request(app).post(`/agent-runs/${run.id}/events`).send({ kind: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('updates status + verdict and stamps endedAt on a terminal status', async () => {
    const run = (await request(app).post('/agent-runs').send({ itemId: 'i5', step: 's' })).body;
    const patched = await request(app).patch(`/agent-runs/${run.id}`).send({ status: 'done', verdict: 'APPROVED' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('done');
    expect(patched.body.verdict).toBe('APPROVED');
    expect(patched.body.endedAt).toBeTruthy(); // auto-stamped
  });

  it('404s for events on an unknown run', async () => {
    expect((await request(app).get('/agent-runs/nope/events')).status).toBe(404);
    expect((await request(app).post('/agent-runs/nope/events').send({ kind: 'note' })).status).toBe(404);
    expect((await request(app).patch('/agent-runs/nope').send({ status: 'done' })).status).toBe(404);
  });
});
