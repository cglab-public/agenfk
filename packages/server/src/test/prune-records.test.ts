/**
 * The upgrade prunes existing cards' step records (TASK 6f774968, BUG
 * ec325925). Cards written before the retention rule carry every capture they
 * ever took, and an inline authoredTests list of every test name. On the first
 * start after the upgrade:
 *  - every card gets the runtime rule: the latest capture of each step and
 *    its latest green, and only greens among its rolled-back captures. A
 *    closed card too: DONE, ARCHIVED and TRASHED can be reopened, a rollback
 *    takes no capture, and the reopened card's next verify reads the latest
 *    capture of its previous step as its baseline (epic review);
 *  - records that are not captures are kept;
 *  - an inline authoredTests list becomes a reference to its capture when that
 *    capture is still on the card;
 *  - blobs nothing references any more are swept, and the run says what it did.
 * It is idempotent: a second start changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { expandAuthored } from '../authoredRecord';

const mod: Record<string, any> = await import('../pruneRecords').catch(() => ({}));
const pruneStepRecords = (storage: any) => {
  expect(typeof mod.pruneStepRecords, 'pruneRecords exports pruneStepRecords').toBe('function');
  return mod.pruneStepRecords(storage);
};

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString();
const tests = (tag: string, failed = false) => [
  { name: `a.test.ts > one ${tag}`, file: 'a.test.ts', status: 'passed' },
  { name: `a.test.ts > two ${tag}`, file: 'a.test.ts', status: failed ? 'failed' : 'passed' },
];
const capture = (step: string, ok: boolean, tag = `${n}`) => ({
  step, kind: 'capture', at: at(), head: 'h', clean: false, exitCode: ok ? 0 : 1, available: true, tests: tests(tag, !ok),
});
const exit = (step: string) => ({ step, kind: 'exit', at: at(), head: 'h', clean: true, checks: [] });

let dir: string;
let storage: SQLiteStorageProvider;
const dbPath = () => path.join(dir, 'db.sqlite');
const blobs = () => {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try { return (db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n; } finally { db.close(); }
};
async function card(id: string, status: string, stepRecords: any[], supersededRecords?: any[]) {
  await storage.createItem({ id, projectId: 'p', type: 'TASK', title: id, status, createdAt: new Date(), updatedAt: new Date() } as any);
  await storage.updateItem(id, { stepRecords, ...(supersededRecords ? { supersededRecords } : {}) } as any);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath() });
  await storage.createProject({ id: 'p', name: 'p', createdAt: new Date(), updatedAt: new Date() } as any);
});
afterEach(async () => {
  await storage?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pruneStepRecords', () => {
  it('gives an open card the runtime rule: latest capture per step plus its latest green', async () => {
    const e = exit('CREATE_UNIT_TESTS');
    const g = capture('IN_PROGRESS', true), r1 = capture('IN_PROGRESS', false), r2 = capture('IN_PROGRESS', false);
    const d = capture('DISCOVERY', true);
    await card('open', 'REFACTOR', [d, e, g, r1, r2]);

    const report = await pruneStepRecords(storage);

    const kept: any = await storage.getItem('open');
    expect(kept.stepRecords.map((r: any) => r.at)).toEqual([d.at, e.at, g.at, r2.at]);
    expect(report).toMatchObject({ cards: 1, records: 1 });
  });

  it('keeps only rolled-back greens on an open card', async () => {
    const g = capture('IN_PROGRESS', true), r = capture('IN_PROGRESS', false);
    await card('open', 'IN_PROGRESS', [exit('TODO')], [g, r]);
    await pruneStepRecords(storage);
    expect(((await storage.getItem('open')) as any).supersededRecords.map((x: any) => x.at)).toEqual([g.at]);
  });

  it('gives a closed card the same rule, so reopening it finds its baselines', async () => {
    const e1 = exit('TODO'), c1 = capture('DISCOVERY', true), ip1 = capture('IN_PROGRESS', false), ip2 = capture('IN_PROGRESS', true);
    const approval = { step: 'DISCOVERY', kind: 'approval', at: at(), id: 'a', by: 'u' };
    const c3 = capture('REFACTOR', true), e2 = exit('REVIEW'), stamp = capture('DONE', true);
    const supGreen = capture('IN_PROGRESS', true), supRed = capture('IN_PROGRESS', false);
    await card('closed', 'DONE', [e1, c1, approval, ip1, ip2, c3, e2, stamp], [supGreen, supRed]);
    const before: any = await storage.getItem('closed');

    const report = await pruneStepRecords(storage);

    const kept: any = await storage.getItem('closed');
    // Each step's latest stays: reopened to REVIEW, its entry baseline is REFACTOR's capture.
    expect(kept.stepRecords.map((r: any) => r.at)).toEqual([e1.at, c1.at, approval.at, ip2.at, c3.at, e2.at, stamp.at]);
    expect(kept.supersededRecords.map((r: any) => r.at)).toEqual([supGreen.at]);
    expect(report).toMatchObject({ cards: 1, records: 2 });
    // A housekeeping rewrite, not an edit: an old card must not jump to the top of "recently updated".
    expect(kept.updatedAt).toEqual(before.updatedAt);
    expect(kept.history ?? []).toEqual(before.history ?? []);
  });

  it('keeps a lone red capture: it is still its step\'s latest, a reopened card\'s baseline', async () => {
    const e = exit('REVIEW'), red = capture('IN_PROGRESS', false);
    await card('closed', 'DONE', [red, e]);
    const report = await pruneStepRecords(storage);
    expect(((await storage.getItem('closed')) as any).stepRecords.map((r: any) => r.at)).toEqual([red.at, e.at]);
    expect(report.cards).toBe(0);
  });

  it('turns an inline authoredTests list into a reference to its capture, reading back the same names', async () => {
    const c = capture('CREATE_UNIT_TESTS', false, 'authored');
    const names = c.tests.map(t => t.name);
    const rec = { step: 'CREATE_UNIT_TESTS', kind: 'record', name: 'authoredTests', value: names, at: at(), head: null, clean: false };
    await card('open', 'IN_PROGRESS', [c, rec]);

    const report = await pruneStepRecords(storage);

    const kept: any = (await storage.getItem('open')) as any;
    const stored = kept.stepRecords.find((r: any) => r.name === 'authoredTests');
    expect(Array.isArray(stored.value)).toBe(false);
    expect(expandAuthored(stored)).toEqual(names);
    expect(report).toMatchObject({ authored: 1 });
  });

  it('leaves an inline authoredTests list alone when its capture is gone', async () => {
    const rec = { step: 'CREATE_UNIT_TESTS', kind: 'record', name: 'authoredTests', value: ['x > y'], at: at(), head: null, clean: false };
    // Two runs of a later step, so the card IS rewritten and the list's fate is observable.
    await card('open', 'IN_PROGRESS', [rec, capture('IN_PROGRESS', false), capture('IN_PROGRESS', false)]);
    const report = await pruneStepRecords(storage);
    expect(report).toMatchObject({ cards: 1, authored: 0 });
    expect(((await storage.getItem('open')) as any).stepRecords[0].value).toEqual(['x > y']);
  });

  it('sweeps the blobs nothing references any more, and counts them', async () => {
    await card('closed', 'DONE', [capture('IN_PROGRESS', false), capture('IN_PROGRESS', false), capture('IN_PROGRESS', false)]);
    expect(blobs()).toBe(3);

    const report = await pruneStepRecords(storage);

    expect(blobs()).toBe(1);
    expect(report).toMatchObject({ blobs: 2 });
  });

  it('is idempotent: a second run changes nothing and reports nothing', async () => {
    await card('closed', 'DONE', [capture('IN_PROGRESS', false), capture('IN_PROGRESS', true), capture('IN_PROGRESS', false)]);
    await card('open', 'IN_PROGRESS', [capture('IN_PROGRESS', false), capture('IN_PROGRESS', false)], [capture('IN_PROGRESS', true)]);
    await pruneStepRecords(storage);
    const before = JSON.stringify([await storage.getItem('closed'), await storage.getItem('open')]);

    const again = await pruneStepRecords(storage);

    expect(again).toEqual({ cards: 0, records: 0, authored: 0, blobs: 0 });
    expect(JSON.stringify([await storage.getItem('closed'), await storage.getItem('open')])).toBe(before);
  });

  it('decides on the light row: a card it does not prune is never read whole', async () => {
    await card('lean', 'IN_PROGRESS', [exit('TODO'), capture('IN_PROGRESS', true), capture('REFACTOR', false)], [capture('IN_PROGRESS', true)]);
    const read: string[] = [];
    const getItem = storage.getItem.bind(storage);
    (storage as any).getItem = async (id: string) => { read.push(id); return getItem(id); };
    await pruneStepRecords(storage);
    expect(read).toEqual([]);
  });

  it('does not touch a card with nothing to prune', async () => {
    await card('lean', 'IN_PROGRESS', [exit('TODO'), capture('IN_PROGRESS', true)]);
    const before: any = await storage.getItem('lean');
    const report = await pruneStepRecords(storage);
    expect(report.cards).toBe(0);
    expect(((await storage.getItem('lean')) as any).updatedAt).toEqual(before.updatedAt);
  });
});
