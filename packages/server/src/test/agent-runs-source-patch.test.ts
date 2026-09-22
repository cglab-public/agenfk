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


const TEST_DB = path.resolve('./agent-runs-source-patch-test-db.sqlite');

describe('PATCH /agent-runs/:id sourcePath (CGLAB-23)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => { await initStorage(); });

  it('updates a run sourcePath so the tailer can attach after the worker launched', async () => {
    const run = (await agent().post('/agent-runs').send({ itemId: 'i-src', step: 'CREATE_UNIT_TESTS' })).body;
    expect(run.sourcePath).toBeFalsy();
    const patched = await agent().patch('/agent-runs/' + run.id).send({ sourcePath: '/abs/sessions/real_sess.jsonl' });
    expect(patched.status).toBe(200);
    expect(patched.body.sourcePath).toBe('/abs/sessions/real_sess.jsonl');
    const list = (await agent().get('/items/i-src/agent-runs')).body;
    expect(list[0].sourcePath).toBe('/abs/sessions/real_sess.jsonl');
  });
});