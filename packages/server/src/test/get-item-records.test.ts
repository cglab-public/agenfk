/**
 * GET /items/:id leaves step records out unless asked (TASK a5f09e66, BUG
 * ec325925). Every capture's whole-suite results came back hydrated on every
 * read of a card: 11 MB for one card in this repo, past what MCP get_item can
 * return. Nothing outside the server reads them over HTTP - the board uses the
 * gates, check-history and warnings endpoints, the list already strips them,
 * and a PUT does not take them - so they are opt-in: ?records=1.
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

const TEST_DB = path.resolve('./get-item-records-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => {
  await initStorage();
  __server = app.listen(0);
  await storage.createProject({ id: 'p', name: 'p', createdAt: new Date(), updatedAt: new Date() } as any);
  await storage.createItem({ id: 'card-1', projectId: 'p', type: 'TASK', title: 'A card', status: 'IN_PROGRESS', comments: [{ id: 'c', author: 'a', content: 'hi', timestamp: new Date() }], createdAt: new Date(), updatedAt: new Date() } as any);
  await storage.updateItem('card-1', {
    stepRecords: [
      { step: 'TODO', kind: 'exit', at: '2026-10-02T12:00:00.000Z', head: 'h', clean: true, checks: [] },
      { step: 'IN_PROGRESS', kind: 'capture', at: '2026-10-02T12:00:01.000Z', head: 'h', clean: false, exitCode: 0, available: true, tests: [{ name: 'a > b', file: 'a', status: 'passed' }] },
    ],
    supersededRecords: [
      { step: 'IN_PROGRESS', kind: 'capture', at: '2026-10-02T11:00:00.000Z', head: 'h', clean: false, exitCode: 0, available: true, tests: [{ name: 'a > b', file: 'a', status: 'passed' }] },
    ],
  } as any);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('GET /items/:id', () => {
  it('returns the card without its step records by default', async () => {
    const res = await agent().get('/items/card-1');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('stepRecords');
    expect(res.body).not.toHaveProperty('supersededRecords');
  });

  it('keeps everything else on the card', async () => {
    const res = await agent().get('/items/card-1');
    expect(res.body).toMatchObject({ id: 'card-1', title: 'A card', status: 'IN_PROGRESS' });
    expect(res.body.comments).toHaveLength(1);
  });

  it('returns the step records, results included, with ?records=1', async () => {
    const res = await agent().get('/items/card-1?records=1');
    expect(res.status).toBe(200);
    expect(res.body.stepRecords.map((r: any) => r.kind)).toEqual(['exit', 'capture']);
    expect(res.body.stepRecords[1].tests).toEqual([{ name: 'a > b', file: 'a', status: 'passed' }]);
    expect(res.body.supersededRecords).toHaveLength(1);
  });

  it('still answers 404 for a card that does not exist', async () => {
    expect((await agent().get('/items/nope')).status).toBe(404);
  });
});
