/**
 * GH-397, through the server: the board prices older usage that has no stored
 * cost from the SAME table the server prices new turns with (GET
 * /usage/prices), so the two never disagree on a rate. Under the test runner
 * the server never fetches: it serves the table saved under ~/.agenfk.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('usage-price-route-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage } from '../server';

const FILE = path.join(os.homedir(), '.agenfk', 'price-table.json');
const SAVED = { fetchedAt: '2026-11-18T08:00:00.000Z', prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };

let __server: import('http').Server;
beforeAll(async () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(SAVED));
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  fs.rmSync(FILE, { force: true });
  await removeTestDb(TEST_DB, closeStorage);
});

describe('GET /usage/prices', () => {
  it("serves the server's own price table, with when it was fetched", async () => {
    const r = await request(__server).get('/usage/prices');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual(SAVED);
  });
});
