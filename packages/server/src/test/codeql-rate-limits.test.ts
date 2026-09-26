/**
 * @file CodeQL js/missing-rate-limiting on PR #194: the flow write routes and
 * the registry install are rate limited. Asserted by the standard RateLimit
 * header express-rate-limit sets, which is what the limiter being in the chain
 * looks like from outside.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(async () => { throw new Error('offline'); }); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./codeql-rate-limits-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => { for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });

const limited = (res: request.Response) => String(res.headers['ratelimit-policy'] ?? res.headers['ratelimit'] ?? '');
const STEPS = [{ name: 'TODO', label: 'TODO', order: 0, isAnchor: true }, { name: 'WORK', label: 'WORK', order: 1 }, { name: 'DONE', label: 'DONE', order: 2, isAnchor: true }];

describe('rate limits on routes CodeQL flagged', () => {
  it('POST /flows and PUT /flows/:id are limited', async () => {
    const created = await agent().post('/flows').send({ name: 'rl-flow', steps: STEPS });
    expect(created.status).toBe(201);
    // The flow-write limiter (600/min), not the 60/min one: the suites and the editor write flows quickly.
    expect(limited(created)).toMatch(/^600;/);
    const updated = await agent().put(`/flows/${created.body.id}`).send({ name: 'rl-flow-2' });
    expect(limited(updated)).toMatch(/^600;/);
  });

  it('POST /registry/flows/install is limited', async () => {
    const res = await agent().post('/registry/flows/install').send({ filename: 'x.json' });
    // limitExpensive (60/min): it reaches the network.
    expect(limited(res)).toMatch(/^60;/);
  });
});
