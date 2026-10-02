/**
 * The server prunes step records when it starts (TASK 6f774968, BUG ec325925):
 * the restart after `agenfk upgrade` is what runs it. Every card keeps what its
 * next check reads, a closed one too (it can be reopened).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./prune-on-start-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
for (const suffix of ['', '-shm', '-wal']) if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);

let n = 0;
const capture = (step: string, ok: boolean) => ({
  step, kind: 'capture', at: new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString(), head: 'h', clean: false,
  exitCode: ok ? 0 : 1, available: true, tests: [{ name: `t ${n}`, file: 'a.test.ts', status: ok ? 'passed' : 'failed' }],
});
const done = [capture('IN_PROGRESS', false), capture('IN_PROGRESS', false), capture('REVIEW', true), capture('DONE', true)];
const open = [capture('IN_PROGRESS', false), capture('IN_PROGRESS', false), capture('IN_PROGRESS', false)];

let storage: any;
const logs: string[] = [];
beforeAll(async () => {
  // A database as the previous release left it: written straight to storage, no retention.
  const before = new SQLiteStorageProvider();
  await before.init({ path: TEST_DB });
  await before.createProject({ id: 'p', name: 'p', createdAt: new Date(), updatedAt: new Date() } as any);
  for (const [id, status, records] of [['done-card', 'DONE', done], ['open-card', 'IN_PROGRESS', open]] as const) {
    await before.createItem({ id, projectId: 'p', type: 'TASK', title: id, status, createdAt: new Date(), updatedAt: new Date() } as any);
    await before.updateItem(id, { stepRecords: records } as any);
  }
  await before.shutdown();

  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const server = await import('../server');
  await server.initStorage();
  storage = server.storage;
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const suffix of ['', '-shm', '-wal']) if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
});

describe('server start after the upgrade', () => {
  it('prunes a closed card by the same rule, keeping each step\'s latest for a reopen', async () => {
    const card = await storage.getItem('done-card');
    expect(card.stepRecords.filter((r: any) => r.kind === 'capture').map((r: any) => r.at)).toEqual([done[1].at, done[2].at, done[3].at]);
  });

  it('gives an open card the runtime rule', async () => {
    const card = await storage.getItem('open-card');
    expect(card.stepRecords.map((r: any) => r.at)).toEqual([open[2].at]);
  });

  it('says what it pruned', () => {
    expect(logs.some(l => /step records/i.test(l) && /2 card/.test(l))).toBe(true);
  });
});
