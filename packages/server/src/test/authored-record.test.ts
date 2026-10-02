/**
 * authoredTests by reference (TASK 55fddd92, BUG ec325925). The record the
 * test-writing step leaves holds every test name in the suite at that moment
 * (~1.2 MB here, inline in the card's row), because test-count-not-lower since
 * test-authoring needs the pre-existing names as well as the card's new ones.
 * They are the names of the capture that step just took, less the new tests a
 * sibling's claim owns. So the record stores only those exclusions, and carries
 * the capture's own results: storage keeps them as the capture's blob (same
 * JSON, same hash), and the record's reference keeps that blob alive after the
 * capture itself is pruned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

const mod: Record<string, any> = await import('../authoredRecord').catch(() => ({}));
const exported = (name: string) => {
  expect(typeof mod[name], `authoredRecord exports ${name}`).toBe('function');
  return mod[name];
};
const compactAuthored = (names: unknown, capture: any) => exported('compactAuthored')(names, capture);
const expandAuthored = (record: any) => exported('expandAuthored')(record);

const t = (name: string, status = 'passed') => ({ name, file: name.split(' > ')[0], status });
const capture = {
  step: 'CREATE_UNIT_TESTS', kind: 'capture', at: '2026-10-02T12:00:00.000Z', exitCode: 1, available: true,
  tests: [t('sum.test.js > adds'), t('a.test.js > aDouble', 'failed'), t('b.test.js > bDouble', 'failed')],
};
const AUTHORED = ['sum.test.js > adds', 'a.test.js > aDouble'];

describe('compactAuthored', () => {
  it('stores the exclusions and the capture\'s results, not a copy of every name', () => {
    const rec = compactAuthored(AUTHORED, capture);
    expect(rec.value).toEqual({ fromCapture: true, excluded: ['b.test.js > bDouble'] });
    expect(rec.tests).toBe(capture.tests);
    expect(JSON.stringify(rec.value)).not.toContain('sum.test.js > adds');
  });

  it('keeps the names as they are when they cannot all be found in the capture', () => {
    const odd = [...AUTHORED, 'gone.test.js > vanished'];
    expect(compactAuthored(odd, capture)).toEqual({ value: odd });
  });

  it('keeps the names as they are when there is no capture with results', () => {
    expect(compactAuthored(AUTHORED, null)).toEqual({ value: AUTHORED });
    expect(compactAuthored(AUTHORED, { ...capture, tests: undefined })).toEqual({ value: AUTHORED });
  });
});

describe('expandAuthored', () => {
  it('gives back exactly the names that were compacted, in order', () => {
    const rec = { kind: 'record', name: 'authoredTests', ...compactAuthored(AUTHORED, capture) };
    expect(expandAuthored(rec)).toEqual(AUTHORED);
  });

  it('passes an old inline array through', () => {
    expect(expandAuthored({ kind: 'record', name: 'authoredTests', value: AUTHORED })).toEqual(AUTHORED);
  });

  it('reads results that could not be loaded as unavailable, never as an empty set', () => {
    expect(expandAuthored({ kind: 'record', name: 'authoredTests', value: { fromCapture: true, excluded: [] }, testsMissing: true })).toBeUndefined();
    expect(expandAuthored({ kind: 'record', name: 'authoredTests', value: { fromCapture: true, excluded: [] } })).toBeUndefined();
  });
});

describe('on real storage', () => {
  let dir: string;
  let storage: SQLiteStorageProvider;
  const dbPath = () => path.join(dir, 'db.sqlite');
  const open = async () => { storage = new SQLiteStorageProvider(); await storage.init({ path: dbPath() }); };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authored-'));
    await open();
    await storage.createProject({ id: 'p', name: 'p', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createItem({ id: 'i', projectId: 'p', type: 'TASK', title: 't', status: 'IN_PROGRESS', createdAt: new Date(), updatedAt: new Date() } as any);
  });
  afterEach(async () => {
    await storage?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const blobCount = () => {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try { return (db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n; } finally { db.close(); }
  };

  it('shares the capture\'s blob, and survives the capture being pruned and the blobs swept', async () => {
    const rec = { step: 'CREATE_UNIT_TESTS', kind: 'record', name: 'authoredTests', at: capture.at, head: null, clean: false, ...compactAuthored(AUTHORED, capture) };
    await storage.updateItem('i', { stepRecords: [capture, rec] } as any);
    expect(blobCount()).toBe(1);

    // The capture goes (a later one of its step replaced it); a restart sweeps unreferenced blobs.
    const fresh: any = await storage.getItem('i');
    await storage.updateItem('i', { stepRecords: fresh.stepRecords.filter((r: any) => r.kind !== 'capture') } as any);
    await storage.shutdown();
    await open();

    expect(blobCount()).toBe(1);
    const kept: any = await storage.getItem('i');
    expect(expandAuthored(kept.stepRecords.find((r: any) => r.name === 'authoredTests'))).toEqual(AUTHORED);
  });
});
