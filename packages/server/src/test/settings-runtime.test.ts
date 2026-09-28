/**
 * @file 7b640e64 — what the machine means for the suite-run limit.
 *
 * The Settings screen offers "Automatic (half the CPUs: N here)" and 1 up to
 * the CPU count, so it has to know the machine. GET /settings/runtime says
 * how many CPUs the server sees, what automatic comes to, and the limit in
 * force now.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./settings-runtime-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 }); await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => { for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });

const cpus = os.cpus().length;
const automatic = Math.max(1, Math.floor(cpus / 2));

describe('GET /settings/runtime', () => {
  it('reports the CPUs, what automatic comes to, and the limit in force', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    const r = await agent().get('/settings/runtime');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cpus, automaticSuiteRuns: automatic, suiteRunLimit: automatic });
  });

  it('follows the setting', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    expect((await agent().get('/settings/runtime')).body.suiteRunLimit).toBe(1);
  });
});
