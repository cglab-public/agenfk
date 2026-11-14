/**
 * CGLAB-607 — immutable flow revisions.
 *
 * A flow used to be one mutable JSON blob: `UPDATE flows SET data = ?` erased
 * the previous definition, so a transition event recorded last month could no
 * longer be checked against the flow that was active then. Now every flow
 * write lands as a NEW revision, old revisions are kept and readable, and a
 * legacy blob-only database is migrated in place on init.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import type { Flow } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `agenfk-flowrev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});

afterEach(async () => {
  await storage.shutdown();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
  }
});

const makeFlow = (id: string, name: string): Flow => ({
  id,
  name,
  steps: [
    { id: 's1', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's2', name: 'IN_PROGRESS', label: 'In Progress', order: 1 },
    { id: 's3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('flow revisions', () => {
  it('records revision 1 when a flow is created', async () => {
    const flow = await storage.createFlow(makeFlow('f1', 'TDD Flow'));
    const revisions = await storage.listFlowRevisions('f1');
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[0].flow.name).toBe('TDD Flow');
    expect(flow).toBeTruthy();
  });

  it('creates a new revision on every update instead of overwriting', async () => {
    await storage.createFlow(makeFlow('f1', 'v1'));
    await storage.updateFlow('f1', { name: 'v2' });
    await storage.updateFlow('f1', { name: 'v3' });

    const revisions = await storage.listFlowRevisions('f1');
    expect(revisions.map((r) => [r.revision, r.flow.name])).toEqual([
      [1, 'v1'],
      [2, 'v2'],
      [3, 'v3'],
    ]);
  });

  it('serves the current revision from getFlow and stamps it', async () => {
    await storage.createFlow(makeFlow('f1', 'v1'));
    await storage.updateFlow('f1', { name: 'v2' });

    const current = await storage.getFlow('f1');
    expect(current?.name).toBe('v2');
    expect(current?.revision).toBe(2);
  });

  it('keeps old revisions immutable after later updates', async () => {
    await storage.createFlow(makeFlow('f1', 'v1'));
    const first = (await storage.listFlowRevisions('f1'))[0];
    await storage.updateFlow('f1', { name: 'v2', steps: makeFlow('f1', 'x').steps });

    // Re-read revision 1: its flow content must be exactly what it was.
    const firstAgain = (await storage.listFlowRevisions('f1'))[0];
    expect(firstAgain.flow.name).toBe('v1');
    expect(firstAgain.flow).toEqual(first.flow);
    expect(firstAgain.flow.steps).toHaveLength(3);
  });

  it('never bakes a stamped revision into the stored blob', async () => {
    await storage.createFlow(makeFlow('f1', 'v1'));
    await storage.updateFlow('f1', { name: 'v2' });
    // Round-trip a full getFlow body as updates — the stale revision
    // it carries must not reach the stored blob either.
    const read = await storage.getFlow('f1');
    await storage.updateFlow('f1', { ...read, name: 'v3' } as never);

    for (const [rev, name] of [[1, 'v1'], [2, 'v2'], [3, 'v3']] as const) {
      const raw = (storage as unknown as { database: { prepare(sql: string): { get(...a: unknown[]): { data: string } | undefined } } })
        .database
        .prepare('SELECT data FROM flow_revisions WHERE flow_id = ? AND revision = ?')
        .get('f1', rev);
      const stored = JSON.parse(raw!.data);
      expect(stored.revision).toBeUndefined();
      expect(stored.name).toBe(name);
    }
  });

  it('deleteFlow removes the revision history too', async () => {
    await storage.createFlow(makeFlow('f1', 'v1'));
    await storage.updateFlow('f1', { name: 'v2' });
    expect(await storage.deleteFlow('f1')).toBe(true);
    expect(await storage.listFlowRevisions('f1')).toEqual([]);
    expect(await storage.getFlow('f1')).toBeNull();
  });

  it('returns an empty list for an unknown flow', async () => {
    return expect(storage.listFlowRevisions('nope')).resolves.toEqual([]);
  });

  it('migrates a legacy blob-only database on init, backfilling revision 1', async () => {
    // Simulate a pre-revision build: a flows row with no revision history.
    (storage as unknown as { database: { prepare(sql: string): { run(...a: unknown[]): void } } })
      .database
      .prepare('INSERT INTO flows (id, data) VALUES (?, ?)')
      .run('legacy', JSON.stringify(makeFlow('legacy', 'Legacy Flow')));
    await storage.shutdown();

    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });

    const current = await storage.getFlow('legacy');
    expect(current?.name).toBe('Legacy Flow');
    const revisions = await storage.listFlowRevisions('legacy');
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision).toBe(1);

    // And a subsequent edit still lands as revision 2.
    await storage.updateFlow('legacy', { name: 'Edited Legacy' });
    const after = await storage.listFlowRevisions('legacy');
    expect(after.map((r) => r.revision)).toEqual([1, 2]);
  });
});
