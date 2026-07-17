/**
 * TDD for async validate runs (CGLAB-10).
 *
 * `agenfk verify` used to hold one HTTP POST open while the server ran the
 * verifyCommand; commands longer than the client's 5-minute axios timeout
 * dropped the connection client-side while the server finished anyway, so
 * agents misread slow success as failure (and could double-transition).
 *
 * Contract under test:
 *  - POST /items/:id/validate with `async: true` returns 202 + { runId }
 *    IMMEDIATELY when a command must execute; the command runs in background.
 *  - GET /items/validate-runs/:runId reports { status: 'running' | 'passed' |
 *    'failed', output } and, once finished, { itemStatus }.
 *  - The background completion applies the SAME side effects as the sync path
 *    (item transition on pass, rollback on fail, validation comment).
 *  - Only one active run per item: a second async validate while one is
 *    running returns 409 with the existing runId.
 *  - Paths that never execute a command (intermediate step with no command)
 *    stay synchronous even when `async: true` is passed — no runId.
 *  - Unknown runId → 404.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./async-validate-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var is set so storage lands in the test DB.
import { app, initStorage, VERIFY_TOKEN } from '../server';

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Poll the run endpoint until it leaves 'running' (or timeout). */
async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await request(app).get(`/items/validate-runs/${runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (res.status !== 200) return res;
    if (res.body.status !== 'running') return res;
    if (Date.now() - start > timeoutMs) return res;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Create project (+ verifyCommand) and a TASK moved to the final intermediate step. */
async function itemOnFinalStep(name: string, verifyCommand: string) {
  const p = (await request(app).post('/projects').send({ name })).body;
  await request(app).put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand });
  const item = (await request(app).post('/items').send({ type: 'TASK', title: `${name}-item`, projectId: p.id })).body;
  await request(app)
    .post('/items/bulk')
    .set('x-agenfk-internal', VERIFY_TOKEN!)
    .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });
  return item;
}

describe('POST /items/:id/validate — async runs', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 202 + runId immediately when a command must run', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV1', 'sleep 1 && echo slow-ok');

    const t0 = Date.now();
    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });

    expect(res.status).toBe(202);
    expect(res.body.runId).toBeTruthy();
    // Immediately = well under the command's own runtime.
    expect(Date.now() - t0).toBeLessThan(900);

    // While the command sleeps, the run reports running and the item is unchanged.
    const mid = await request(app).get(`/items/validate-runs/${res.body.runId}`).set('x-agenfk-internal', VERIFY_TOKEN);
    expect(mid.status).toBe(200);
    expect(['running', 'passed']).toContain(mid.body.status);
  });

  it('applies the pass side effects in the background (transition + comment + captured output)', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV2', 'echo async-pass-output');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, evidence: 'async pass test' });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('passed');
    expect(done.body.output).toContain('async-pass-output');
    expect(done.body.itemStatus).toBe('DONE');

    const after = (await request(app).get(`/items/${item.id}`)).body;
    expect(after.status).toBe('DONE');
    const validationComments = (after.comments || []).filter((c: any) => c.author === 'ValidateTool');
    expect(validationComments.length).toBeGreaterThan(0);
  });

  it('applies the failure side effects in the background (rollback to coding step)', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV3', 'echo async-fail-output && exit 3');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('failed');
    expect(done.body.output).toContain('async-fail-output');

    const after = (await request(app).get(`/items/${item.id}`)).body;
    expect(after.status).not.toBe('DONE');
    expect(after.status).not.toBe('TEST'); // rolled back off the final step
  });

  it('rejects a concurrent run for the same item with 409 + the active runId', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV4', 'sleep 2 && echo done');

    const first = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(second.status).toBe(409);
    expect(second.body.runId).toBe(first.body.runId);

    await waitForRun(first.body.runId);
  });

  it('stays synchronous when no command would run (intermediate step, async flag ignored)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await request(app).post('/projects').send({ name: 'AV5' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'AV5-item', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
    expect(res.body.status).toBe('REVIEW');
  });

  it('returns 404 for an unknown runId', async () => {
    if (!VERIFY_TOKEN) return;
    const res = await request(app)
      .get('/items/validate-runs/00000000-0000-0000-0000-000000000000')
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(res.status).toBe(404);
  });

  it('sync behaviour unchanged when async is not requested', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV6', 'echo sync-still-works');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DONE');
    expect(res.body.output).toContain('sync-still-works');
  });
});
