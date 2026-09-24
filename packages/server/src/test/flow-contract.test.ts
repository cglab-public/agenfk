/**
 * @file CGLAB-384 (S8-T1) — the local server tells the flow editor what a
 * draft flow's steps mean (POST /flows/contract), with the functions that
 * validate a save and run verify. Read-only: it stores nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const TEST_DB = path.resolve('./flow-contract-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) { const f = `${TEST_DB}${suffix}`; if (fs.existsSync(f)) fs.unlinkSync(f); }
});

const steps = [
  { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 'b', name: 'SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
  { id: 'c', name: 'BUILD', label: 'Build', order: 2, role: 'coding', checks: [{ id: 'jira-key-valid' }] },
  { id: 'd', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
];

describe('POST /flows/contract', () => {
  it("returns each step's checks and what it produces, and says the draft is valid", async () => {
    const res = await agent().post('/flows/contract').send({ steps });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.steps[1].produces).toContain('redSet');
    expect(res.body.steps[2].checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(['red-set-passes-by-name', 'jira-key-valid']));
  });

  it('reports the error a save would be refused with, and stores nothing', async () => {
    const before = (await agent().get('/flows')).body.length;
    const bad = steps.map(s => (s.name === 'SPECS' ? { ...s, role: undefined } : s)).map(s => (s.name === 'BUILD' ? { ...s, checks: [{ id: 'red-set-passes-by-name' }] } : s));
    const res = await agent().post('/flows/contract').send({ steps: bad });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join(' ')).toMatch(/redSet/);
    expect((await agent().get('/flows')).body.length).toBe(before);
  });
});
