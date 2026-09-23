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
 *    (item transition on pass, refused advance on fail — the card stays put, validation comment).
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
import { app, initStorage, VERIFY_TOKEN, storage } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 22 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


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
    const res = await agent().get(`/items/validate-runs/${runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (res.status !== 200) return res;
    if (res.body.status !== 'running') return res;
    if (Date.now() - start > timeoutMs) return res;
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Create project (+ verifyCommand) and a TASK moved to the final intermediate
 * step.
 *
 * EVERY STEP IS CHECKED, and that is the point rather than defensiveness.
 *
 * This helper made four requests and looked at none of them. When one of them
 * did not do what it was asked, the test carried on with a half-built fixture —
 * no verify command, or an item not on the step that makes a command run — and
 * the validate then answered 200 instead of 202 because there was nothing to
 * run in the background. The failure surfaced as an assertion about the
 * behaviour under test, several lines away from the request that actually
 * broke, which is how a setup problem gets mistaken for a product one.
 *
 * Part of the rotating-failure investigation (BUG 9de0c99c): the "different
 * test every run" shape is what you get when several helpers can each fail
 * silently in their own way.
 */
async function itemOnFinalStep(name: string, verifyCommand: string) {
  const project = await agent().post('/projects').send({ name });
  expect(project.status, `could not create project ${name}: ${JSON.stringify(project.body)}`).toBe(201);

  const cmd = await agent().put(`/projects/${project.body.id}/verify-command`)
    .set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand });
  expect(cmd.status, `could not set the verify command: ${JSON.stringify(cmd.body)}`).toBe(200);

  const created = await agent().post('/items')
    .send({ type: 'TASK', title: `${name}-item`, projectId: project.body.id });
  expect(created.status, `could not create the item: ${JSON.stringify(created.body)}`).toBe(201);

  await storage.updateItem(created.body.id, { status: 'TEST' } as any);

  // The state the test actually depends on, read back rather than assumed: a
  // validate only goes asynchronous when there is a command to run AND the item
  // is on the step that runs it.
  const readBack = await agent().get(`/items/${created.body.id}`);
  expect(readBack.body.status, 'the item is not on the step a command runs on').toBe('TEST');
  return created.body;
}

describe('POST /items/:id/validate — async runs', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 202 + runId immediately when a command must run', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV1', 'sleep 2 && echo slow-ok');

    const t0 = Date.now();
    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });

    expect(res.status).toBe(202);
    expect(res.body.runId).toBeTruthy();
    // Immediately = well under the command's own runtime (generous margin for loaded CI).
    expect(Date.now() - t0).toBeLessThan(1900);

    // While the command sleeps, the run reports running and the item is unchanged.
    const mid = await agent().get(`/items/validate-runs/${res.body.runId}`).set('x-agenfk-internal', VERIFY_TOKEN);
    expect(mid.status).toBe(200);
    expect(['running', 'passed']).toContain(mid.body.status);

    // Don't leak the background run into the next test.
    await waitForRun(res.body.runId);
  });

  it('blocks a SYNC validate while a background run is active (old-client race)', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV1b', 'sleep 2 && echo guard-ok');

    const first = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(first.status).toBe(202);

    const sync = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({}); // no async flag — old client
    expect(sync.status).toBe(409);
    expect(sync.body.runId).toBe(first.body.runId);

    await waitForRun(first.body.runId);
  });

  it('applies the pass side effects in the background (transition + comment + captured output)', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV2', 'echo async-pass-output');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, evidence: 'async pass test' });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('passed');
    expect(done.body.output).toContain('async-pass-output');
    expect(done.body.itemStatus).toBe('DONE');

    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('DONE');
    const validationComments = (after.comments || []).filter((c: any) => c.author === 'ValidateTool');
    expect(validationComments.length).toBeGreaterThan(0);
  });

  it('applies the failure side effects in the background (refused advance, card stays put)', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV3', 'echo async-fail-output && exit 3');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('failed');
    expect(done.body.output).toContain('async-fail-output');

    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).not.toBe('DONE');
    // CGLAB-275: a failed gate refuses the advance and moves the card nowhere.
    // It used to roll back to the coding step, which on a custom flow could be
    // two steps behind and was never reported.
    expect(after.status).toBe('TEST');
    expect(done.body.itemStatus).toBe('TEST');
  });

  it('rejects a concurrent run for the same item with 409 + the active runId', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV4', 'sleep 2 && echo done');

    const first = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(first.status).toBe(202);

    const second = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });
    expect(second.status).toBe(409);
    expect(second.body.runId).toBe(first.body.runId);

    await waitForRun(first.body.runId);
  });

  it('stays synchronous when no command would run (intermediate step, async flag ignored)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'AV5' })).body;
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'AV5-item', projectId: p.id })).body;
    await storage.updateItem(item.id, { status: 'IN_PROGRESS' } as any);

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
    expect(res.body.status).toBe('REVIEW');
  });

  it('returns 404 for an unknown runId', async () => {
    if (!VERIFY_TOKEN) return;
    const res = await agent()
      .get('/items/validate-runs/00000000-0000-0000-0000-000000000000')
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(res.status).toBe(404);
  });

  it('sync behaviour unchanged when async is not requested', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnFinalStep('AV6', 'echo sync-still-works');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DONE');
    expect(res.body.output).toContain('sync-still-works');
  });
});
