/**
 * GH-288 — `agenfk db status` shows what the database file holds, and
 * `agenfk db vacuum` compacts it through the server, which owns the file:
 * never while a verify suite run is going, since the vacuum holds the
 * database for its whole duration.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('db-vacuum-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, VERIFY_TOKEN, acquireSuiteRun } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
});

const vacuum = () => agent().post('/db/vacuum').set('x-agenfk-internal', VERIFY_TOKEN);

describe('GET /db/status', () => {
  it('reports the file and WAL sizes and the reclaimable space, without reading every page', async () => {
    const res = await agent().get('/db/status');
    expect(res.status).toBe(200);
    const { size } = res.body;
    expect(size.fileBytes).toBe(fs.statSync(TEST_DB).size);
    expect(typeof size.walBytes).toBe('number');
    expect(typeof size.reclaimableBytes).toBe('number');
    expect(size.tables).toBeUndefined();
  });

  it('adds the largest tables when asked for', async () => {
    const res = await agent().get('/db/status?tables=1');
    expect(res.body.size.tables.map((t: { name: string }) => t.name)).toContain('items');
  });
});

describe('POST /db/vacuum', () => {
  it('needs the internal token', async () => {
    const res = await agent().post('/db/vacuum');
    expect(res.status).toBe(401);
  });

  it('compacts the database and reports the size before and after, checked', async () => {
    const res = await vacuum();
    expect(res.status).toBe(200);
    expect(res.body.check).toBe('ok');
    expect(res.body.after.fileBytes).toBe(fs.statSync(TEST_DB).size);
    expect(res.body.after.walBytes).toBe(0);
    expect(typeof res.body.before.fileBytes).toBe('number');
  });

  it('is refused while a suite run is in flight, naming its card, and runs once it ends', async () => {
    const pid = (await agent().post('/projects').send({ name: 'vacuum-busy' })).body.id as string;
    const release = await acquireSuiteRun(pid, () => {}, 'card-running-1');
    try {
      const res = await vacuum();
      expect(res.status).toBe(409);
      expect(res.body.running).toEqual(['card-running-1']);
      expect(res.body.error).toMatch(/card-running-1/);
    } finally {
      release();
    }
    expect((await vacuum()).status).toBe(200);
  });

  it('counts a run that is still queued for a slot as in flight', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    const pid = (await agent().post('/projects').send({ name: 'vacuum-queued' })).body.id as string;
    const first = await acquireSuiteRun(pid, () => {}, 'card-first');
    let releaseSecond: (() => void) | undefined;
    const second = acquireSuiteRun(pid, () => {}, 'card-queued').then(r => { releaseSecond = r; });
    try {
      const res = await vacuum();
      expect(res.status).toBe(409);
      expect([...res.body.running].sort()).toEqual(['card-first', 'card-queued']);
    } finally {
      first();
      await second;
      releaseSecond?.();
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    }
    expect((await vacuum()).status).toBe(200);
  });
});
