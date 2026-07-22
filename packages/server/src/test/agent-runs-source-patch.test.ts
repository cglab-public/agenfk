import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

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
    const run = (await request(app).post('/agent-runs').send({ itemId: 'i-src', step: 'CREATE_UNIT_TESTS' })).body;
    expect(run.sourcePath).toBeFalsy();
    const patched = await request(app).patch('/agent-runs/' + run.id).send({ sourcePath: '/abs/sessions/real_sess.jsonl' });
    expect(patched.status).toBe(200);
    expect(patched.body.sourcePath).toBe('/abs/sessions/real_sess.jsonl');
    const list = (await request(app).get('/items/i-src/agent-runs')).body;
    expect(list[0].sourcePath).toBe('/abs/sessions/real_sess.jsonl');
  });
});