/**
 * Captures kept by need (TASK 81e21940, BUG ec325925). Every capture holds the
 * whole suite's per-test results, and nothing ever dropped one: a card in this
 * repo carried four (~8 MB hydrated) plus up to 20 superseded ones. What the
 * checks and reuse read is narrower:
 *  - the entry baseline: the latest capture of the previous step;
 *  - reuse: a green whose tree state matches, newest first;
 *  - rollback refusal: the latest capture of the step before the occupied one.
 * So an open card keeps the latest capture of each step plus its latest green,
 * and a rolled-back capture is worth keeping only if it is a green. Records of
 * every other kind (exits, approvals, overrides, named records) are kept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

// Loaded, not imported: until the module exists, each test fails on an
// assertion naming the missing export rather than the whole file on import.
const mod: Record<string, any> = await import('../recordRetention').catch(() => ({}));
const exported = (name: string) => {
  expect(typeof mod[name], `recordRetention exports ${name}`).toBe('function');
  return mod[name];
};
const retainCaptures = (records?: any[]) => exported('retainCaptures')(records);
const retainSuperseded = (records?: any[]) => exported('retainSuperseded')(records);
const withRecordRetention = (s: SQLiteStorageProvider): SQLiteStorageProvider => exported('withRecordRetention')(s);

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString();
const green = (step: string, extra: Record<string, unknown> = {}) => ({
  step, kind: 'capture', at: at(), head: 'h', clean: false, exitCode: 0, available: true,
  tests: [{ name: `t-${n}`, file: 'a.test.ts', status: 'passed' }], ...extra,
});
const red = (step: string) => ({
  step, kind: 'capture', at: at(), head: 'h', clean: false, exitCode: 1, available: true,
  tests: [{ name: `t-${n}`, file: 'a.test.ts', status: 'failed' }],
});
const exit = (step: string) => ({ step, kind: 'exit', at: at(), head: 'h', clean: true, checks: [] });
const record = (step: string, name: string) => ({ step, kind: 'record', name, value: [1], at: at(), head: null, clean: false });

describe('retainCaptures on an open card', () => {
  it('keeps only the latest capture of each step', () => {
    const a1 = red('IN_PROGRESS'), a2 = red('IN_PROGRESS'), a3 = red('IN_PROGRESS');
    expect(retainCaptures([a1, a2, a3])).toEqual([a3]);
  });

  it('keeps the latest green even when a later capture of its step is red', () => {
    const g = green('IN_PROGRESS'), r = red('IN_PROGRESS');
    expect(retainCaptures([g, r])).toEqual([g, r]);
  });

  it('keeps one capture per step across steps, in their original order', () => {
    const d = green('DISCOVERY'), c1 = red('CREATE_UNIT_TESTS'), c2 = red('CREATE_UNIT_TESTS'), i = green('IN_PROGRESS');
    expect(retainCaptures([d, c1, c2, i])).toEqual([d, c2, i]);
  });

  it('keeps only the newest of several greens when each is superseded in its step', () => {
    const g1 = green('IN_PROGRESS'), g2 = green('IN_PROGRESS'), r = red('IN_PROGRESS');
    expect(retainCaptures([g1, g2, r])).toEqual([g2, r]);
  });

  it('never drops a record that is not a capture', () => {
    const e1 = exit('TODO'), rs = record('CREATE_UNIT_TESTS', 'redSet'), a = red('IN_PROGRESS'), e2 = exit('IN_PROGRESS'), b = red('IN_PROGRESS');
    const approval = { step: 'DISCOVERY', kind: 'approval', at: at(), id: 'x', by: 'u' };
    expect(retainCaptures([e1, approval, rs, a, e2, b])).toEqual([e1, approval, rs, e2, b]);
  });

  it('treats unreadable results as not green', () => {
    const missing = { ...green('IN_PROGRESS'), testsMissing: true };
    const later = red('IN_PROGRESS');
    expect(retainCaptures([missing, later])).toEqual([later]);
  });

  it('leaves an empty or absent list as it is', () => {
    expect(retainCaptures([])).toEqual([]);
    expect(retainCaptures(undefined)).toBeUndefined();
  });
});

describe('retainSuperseded', () => {
  it('keeps rolled-back greens only', () => {
    const g = green('IN_PROGRESS'), r = red('IN_PROGRESS');
    expect(retainSuperseded([g, r])).toEqual([g]);
  });

  it('keeps the newest 20 greens', () => {
    const greens = Array.from({ length: 25 }, () => green('IN_PROGRESS'));
    expect(retainSuperseded(greens)).toEqual(greens.slice(-20));
  });
});

describe('withRecordRetention on real storage', () => {
  let dir: string;
  let storage: SQLiteStorageProvider;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
    storage = withRecordRetention(new SQLiteStorageProvider());
    await storage.init({ path: path.join(dir, 'db.sqlite') });
    await storage.createProject({ id: 'p', name: 'p', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createItem({ id: 'i', projectId: 'p', type: 'TASK', title: 't', status: 'IN_PROGRESS', createdAt: new Date(), updatedAt: new Date() } as any);
  });
  afterEach(async () => {
    await storage?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes captures on every stepRecords write, whoever writes', async () => {
    const e = exit('CREATE_UNIT_TESTS'), r1 = red('IN_PROGRESS'), r2 = red('IN_PROGRESS'), r3 = red('IN_PROGRESS');
    for (const rec of [e, r1, r2, r3]) {
      const fresh: any = await storage.getItem('i');
      await storage.updateItem('i', { stepRecords: [...(fresh.stepRecords ?? []), rec] } as any);
    }
    const kept: any = await storage.getItem('i');
    expect(kept.stepRecords.map((r: any) => r.at)).toEqual([e.at, r3.at]);
    expect(kept.stepRecords[1].tests).toEqual(r3.tests);
  });

  it('prunes superseded captures on write', async () => {
    const g = green('IN_PROGRESS'), r = red('IN_PROGRESS');
    await storage.updateItem('i', { supersededRecords: [g, r] } as any);
    const kept: any = await storage.getItem('i');
    expect(kept.supersededRecords.map((x: any) => x.at)).toEqual([g.at]);
  });

  it('leaves an update without records alone', async () => {
    const updated: any = await storage.updateItem('i', { title: 'renamed' } as any);
    expect(updated.title).toBe('renamed');
    expect(updated.stepRecords).toBeUndefined();
  });
});
