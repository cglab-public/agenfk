/**
 * REST surface for agent runs (CGLAB-18a). Behaviour-based: drives the real
 * Express app + storage against a temp DB via supertest.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. That
 * churn produced `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` — a
 * transport failure, not an assertion about anything under test. It hands the
 * test an empty body, so `res.body.id` is undefined and the next call goes to
 * `/items/undefined`; one bad socket then surfaces as `expected 404 to be 400`
 * in whichever test happened to be running. Different test every run, green
 * when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


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
    const create = await agent().post('/agent-runs').send({
      itemId: 'item-X', projectId: 'p1', step: 'CREATE_UNIT_TESTS',
      actor: 'worker', harness: 'pi', model: 'qwen3.6:27b', sessionId: 'sess-1',
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();
    expect(create.body.status).toBe('running');

    const list = await agent().get('/items/item-X/agent-runs');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].sessionId).toBe('sess-1');
  });

  it('rejects an invalid actor and a missing itemId', async () => {
    expect((await agent().post('/agent-runs').send({ itemId: 'i', step: 's', actor: 'nope' })).status).toBe(400);
    expect((await agent().post('/agent-runs').send({ step: 's' })).status).toBe(400);
  });

  it('appends events with auto-incrementing seq and lists them ordered', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i2', step: 'IN_PROGRESS' })).body;
    await agent().post(`/agent-runs/${run.id}/events`).send({ lane: 'orchestrator', kind: 'dispatch', text: 'go' });
    await agent().post(`/agent-runs/${run.id}/events`).send({ lane: 'worker', kind: 'tool', tool: 'bash', text: 'npx vitest' });
    const res = await agent().post(`/agent-runs/${run.id}/events`).send({ lane: 'worker', kind: 'result', text: '3 passed' });
    expect(res.status).toBe(201);

    const events = await agent().get(`/agent-runs/${run.id}/events`);
    expect(events.body.map((e: any) => e.seq)).toEqual([0, 1, 2]);
    expect(events.body.map((e: any) => e.kind)).toEqual(['dispatch', 'tool', 'result']);
  });

  it('serializes an object payload to JSON', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i3', step: 's' })).body;
    await agent().post(`/agent-runs/${run.id}/events`).send({ kind: 'diff', payload: { added: 14, removed: 2 } });
    const events = (await agent().get(`/agent-runs/${run.id}/events`)).body;
    expect(JSON.parse(events[0].payload)).toEqual({ added: 14, removed: 2 });
  });

  it('rejects an invalid event kind', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i4', step: 's' })).body;
    const res = await agent().post(`/agent-runs/${run.id}/events`).send({ kind: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('updates status + verdict and stamps endedAt on a terminal status', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i5', step: 's' })).body;
    const patched = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done', verdict: 'APPROVED' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('done');
    expect(patched.body.verdict).toBe('APPROVED');
    expect(patched.body.endedAt).toBeTruthy(); // auto-stamped
  });

  it('refuses to reopen a finished run, and leaves its endedAt alone', async () => {
    /*
     * BUG 43ac6afe. The route validated set membership only, so a finished
     * run accepted {status:'running'} and ended up saying "running, finished
     * at 14:02". The rule that refuses this has existed in dispatch.ts all
     * along; the route simply never asked it.
     */
    const run = (await agent().post('/agent-runs').send({ itemId: 'i6', step: 's' })).body;
    const done = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done' });
    expect(done.body.endedAt).toBeTruthy();
    const endedAt = done.body.endedAt;

    const reopen = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'running' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toMatch(/start a new one/i);

    const after = (await agent().get('/items/i6/agent-runs')).body[0];
    expect(after.status).toBe('done');
    expect(after.endedAt).toBe(endedAt);
  });

  it('will not retcon a failed run into a done one', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i7', step: 's' })).body;
    await agent().patch(`/agent-runs/${run.id}`).send({ status: 'failed' });
    const res = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done' });
    expect(res.status).toBe(409);
  });

  it('treats a resend of the same terminal status as a no-op, keeps its endedAt', async () => {
    /*
     * The retry that actually happens: the hook and `agenfk run end` both
     * send `{status:'done'}` (bin/agenfk-run-hook.mjs:219, cli run end). A
     * dropped response is re-sent, and the second one must not re-stamp a run
     * that already ended.
     */
    const run = (await agent().post('/agent-runs').send({ itemId: 'i8', step: 's' })).body;
    const done = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done' });
    const res = await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.endedAt).toBe(done.body.endedAt);
  });

  it('rejects an empty status instead of persisting an unreadable one', async () => {
    /*
     * `''` is truthy-false, so the old `if (status && ...)` let it past both
     * validations and `status !== undefined` wrote it. The column is NOT NULL
     * with no CHECK, so it stuck - and once the transition guard is in place
     * an unknown `from` refuses every later move, freezing the run for good.
     */
    const run = (await agent().post('/agent-runs').send({ itemId: 'i9', step: 's' })).body;
    await agent().patch(`/agent-runs/${run.id}`).send({ status: 'done' });

    const res = await agent().patch(`/agent-runs/${run.id}`).send({ status: '' });
    expect(res.status).toBe(400);

    const after = (await agent().get('/items/i9/agent-runs')).body[0];
    expect(after.status).toBe('done');
  });

  it('refuses a client-supplied endedAt: the server owns the stamp', async () => {
    /*
     * Letting it through put both halves of the incoherence in the record: a
     * finished run whose end time was rewritten, and a running run stamped as
     * already ended - "running, finished at 14:02". The server is the only
     * party that knows when it saw the run end, so it is the only writer.
     */
    const finished = (await agent().post('/agent-runs').send({ itemId: 'i10', step: 's' })).body;
    await agent().patch(`/agent-runs/${finished.id}`).send({ status: 'done' });
    const stamped = (await agent().get('/items/i10/agent-runs')).body[0].endedAt;

    const rewrite = await agent().patch(`/agent-runs/${finished.id}`).send({ endedAt: '1999-01-01T00:00:00.000Z' });
    expect(rewrite.status).toBe(400);
    expect((await agent().get('/items/i10/agent-runs')).body[0].endedAt).toBe(stamped);

    const running = (await agent().post('/agent-runs').send({ itemId: 'i11', step: 's' })).body;
    expect((await agent().patch(`/agent-runs/${running.id}`).send({ endedAt: '1999-01-01T00:00:00.000Z' })).status).toBe(400);
    const after = (await agent().get('/items/i11/agent-runs')).body[0];
    expect(after.status).toBe('running');
    expect(after.endedAt).toBeFalsy();

    // A null is the same body serialised by another client, not another request.
    expect((await agent().patch(`/agent-runs/${running.id}`).send({ status: 'done', endedAt: null })).status).toBe(400);
    // And the refusal wrote nothing: not even the status half of the body.
    const stillRunning = (await agent().get('/items/i11/agent-runs')).body[0];
    expect(stillRunning.status).toBe('running');
    expect(stillRunning.endedAt).toBeFalsy();
  });

  it('answers 400, not 500, for a non-string field', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i12', step: 's' })).body;
    expect((await agent().patch(`/agent-runs/${run.id}`).send({ verdict: {} })).status).toBe(400);
    expect((await agent().patch(`/agent-runs/${run.id}`).send({ sourcePath: [] })).status).toBe(400);
    // `['x']` fills exactly one bind slot, so without the guard it did not
    // throw - it wrote `'x'` and echoed the array back.
    expect((await agent().patch(`/agent-runs/${run.id}`).send({ sourcePath: ['x'] })).status).toBe(400);

    // The create route had the same hole one screen up.
    expect((await agent().post('/agent-runs').send({ itemId: 'i12', step: { nope: true } })).status).toBe(400);
    expect((await agent().post('/agent-runs').send({ itemId: 'i12', step: 's', model: {} })).status).toBe(400);
  });

  it('404s for events on an unknown run', async () => {
    expect((await agent().get('/agent-runs/nope/events')).status).toBe(404);
    expect((await agent().post('/agent-runs/nope/events').send({ kind: 'note' })).status).toBe(404);
    expect((await agent().patch('/agent-runs/nope').send({ status: 'done' })).status).toBe(404);
  });
});
