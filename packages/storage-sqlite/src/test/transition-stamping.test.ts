/**
 * CGLAB-608 — transition events carry the flow version that was active when
 * they happened. The score (story 3) may count ONLY stamped events, so every
 * status change — verify, board drag, propagation, rollback — must be stamped
 * at the single choke point all of them share: storage.updateItem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType } from '@agenfk/core';
import type { Project, Flow, AgEnFKItem } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;
let project: Project;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `agenfk-stamp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
  project = await storage.createProject({
    id: 'p1',
    name: 'P',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Project);
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

const makeItem = (): AgEnFKItem =>
  ({
    id: 'i1',
    projectId: 'p1',
    type: ItemType.TASK,
    title: 'T',
    status: 'TODO' as AgEnFKItem['status'],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgEnFKItem);

describe('transition event stamping', () => {
  it('stamps the project flow id + current revision on every status change', async () => {
    await storage.createFlow(makeFlow('f1', 'Flow'));
    await storage.updateProject('p1', { flowId: 'f1' } as Partial<Project>);
    await storage.createItem(makeItem());

    await storage.updateItem('i1', { status: 'IN_PROGRESS' as AgEnFKItem['status'] });
    const item = await storage.getItem('i1');
    const stamps = (item!.history || []).map((h) => [h.flowId, h.flowRevision]);
    expect(stamps[stamps.length - 1]).toEqual(['f1', 1]);
  });

  it('stamps the revision that was current at the time — a later flow edit does not rewrite old events', async () => {
    await storage.createFlow(makeFlow('f1', 'Flow'));
    await storage.updateProject('p1', { flowId: 'f1' } as Partial<Project>);
    await storage.createItem(makeItem());

    await storage.updateItem('i1', { status: 'IN_PROGRESS' as AgEnFKItem['status'] });
    await storage.updateFlow('f1', { name: 'Flow v2' });
    await storage.updateItem('i1', { status: 'DONE' as AgEnFKItem['status'] });

    const item = await storage.getItem('i1');
    const history = item!.history || [];
    expect(history.map((h) => [h.toStatus, h.flowRevision])).toEqual([
      ['TODO', 1],
      ['IN_PROGRESS', 1],
      ['DONE', 2],
    ]);
  });

  it('leaves transitions unstamped when the project has no flow', async () => {
    await storage.createItem(makeItem());
    await storage.updateItem('i1', { status: 'IN_PROGRESS' as AgEnFKItem['status'] });
    const item = await storage.getItem('i1');
    const last = (item!.history || [])[(item!.history || []).length - 1];
    expect(last.flowId).toBeUndefined();
    expect(last.flowRevision).toBeUndefined();
  });

  it('does not stamp non-status updates or same-status writes', async () => {
    await storage.createFlow(makeFlow('f1', 'Flow'));
    await storage.updateProject('p1', { flowId: 'f1' } as Partial<Project>);
    await storage.createItem(makeItem());

    await storage.updateItem('i1', { title: 'New title' } as Partial<AgEnFKItem>);
    await storage.updateItem('i1', { status: 'TODO' as AgEnFKItem['status'] });
    const item = await storage.getItem('i1');
    expect(item!.history).toHaveLength(1); // only the create stamp
  });

  it('stamps rollbacks and backward moves the same as forward moves', async () => {
    await storage.createFlow(makeFlow('f1', 'Flow'));
    await storage.updateProject('p1', { flowId: 'f1' } as Partial<Project>);
    await storage.createItem(makeItem());
    await storage.updateItem('i1', { status: 'IN_PROGRESS' as AgEnFKItem['status'] });
    await storage.updateItem('i1', { status: 'TODO' as AgEnFKItem['status'] });
    const item = await storage.getItem('i1');
    const last = (item!.history || [])[(item!.history || []).length - 1];
    expect([last.fromStatus, last.toStatus, last.flowId, last.flowRevision]).toEqual([
      'IN_PROGRESS', 'TODO', 'f1', 1,
    ]);
  });
});
