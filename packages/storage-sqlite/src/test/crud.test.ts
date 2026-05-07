import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem, type Project, type Flow, type PauseSnapshot } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDb = (suffix: string) =>
  path.join(os.tmpdir(), `agenfk-crud-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

const cleanup = (dbPath: string) => {
  for (const s of ['', '-wal', '-shm']) {
    const f = dbPath + s;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const makeProject = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project One',
  description: 'desc',
  verifyCommand: 'npm test',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  ...over,
});

const makeItem = (over: Partial<AgEnFKItem> = {}): AgEnFKItem => ({
  id: 'i1',
  projectId: 'p1',
  type: ItemType.TASK,
  title: 'Task title',
  description: 'task desc',
  status: Status.IN_PROGRESS,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
} as AgEnFKItem);

const makeFlow = (over: Partial<Flow> = {}): Flow => ({
  id: 'flow-1',
  name: 'Default',
  description: 'd',
  steps: [
    { id: 's0', name: 'TODO', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'IN_PROGRESS', label: 'In progress', order: 1 },
    { id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const makeSnapshot = (over: Partial<PauseSnapshot> = {}): PauseSnapshot => ({
  id: 's1',
  itemId: 'i1',
  projectId: 'p1',
  status: Status.IN_PROGRESS,
  summary: 'summary',
  filesModified: ['a.ts', 'b.ts'],
  branchName: 'feature/x',
  gitDiff: 'diff --git a/a b/b',
  resumeInstructions: 'pick up at step 3',
  pausedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('SQLiteStorageProvider — init / shutdown / database guard', () => {
  it('init() creates a missing parent directory', async () => {
    const dir = path.join(os.tmpdir(), `agenfk-init-mkdir-${process.pid}-${Date.now()}`);
    const dbPath = path.join(dir, 'nested', 'db.sqlite');
    expect(fs.existsSync(dir)).toBe(false);
    const storage = new SQLiteStorageProvider();
    try {
      await storage.init({ path: dbPath });
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      expect(storage.dbPath).toBe(dbPath);
    } finally {
      await storage.shutdown();
      cleanup(dbPath);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('init() defaults to .agenfk/db.sqlite when path is not provided', async () => {
    const cwd = process.cwd();
    const sandbox = path.join(os.tmpdir(), `agenfk-default-path-${process.pid}-${Date.now()}`);
    fs.mkdirSync(sandbox, { recursive: true });
    process.chdir(sandbox);
    const storage = new SQLiteStorageProvider();
    try {
      await storage.init({});
      expect(storage.dbPath).toBe('.agenfk/db.sqlite');
      expect(fs.existsSync(path.join(sandbox, '.agenfk'))).toBe(true);
    } finally {
      await storage.shutdown();
      process.chdir(cwd);
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('shutdown() is idempotent', async () => {
    const dbPath = tmpDb('shutdown');
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    await expect(storage.shutdown()).resolves.toBeUndefined();
    await expect(storage.shutdown()).resolves.toBeUndefined();
    cleanup(dbPath);
  });

  it('any operation before init() throws a clear error', async () => {
    const storage = new SQLiteStorageProvider();
    await expect(storage.listProjects()).rejects.toThrow(/not initialized/i);
  });

  it('operations after shutdown() throw the not-initialized error', async () => {
    const dbPath = tmpDb('post-shutdown');
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    await storage.shutdown();
    await expect(storage.listProjects()).rejects.toThrow(/not initialized/i);
    cleanup(dbPath);
  });
});

describe('SQLiteStorageProvider — Projects', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb('projects');
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanup(dbPath);
  });

  it('createProject returns the project as inserted', async () => {
    const p = await storage.createProject(makeProject());
    expect(p.id).toBe('p1');
    expect(p.name).toBe('Project One');
  });

  it('getProject deserializes Date fields from JSON', async () => {
    await storage.createProject(makeProject());
    const got = await storage.getProject('p1');
    expect(got).not.toBeNull();
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.updatedAt).toBeInstanceOf(Date);
    expect(got!.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('getProject returns null for a missing id', async () => {
    expect(await storage.getProject('nope')).toBeNull();
  });

  it('updateProject merges fields, bumps updatedAt, and persists', async () => {
    await storage.createProject(makeProject());
    const before = (await storage.getProject('p1'))!.updatedAt.getTime();
    const updated = await storage.updateProject('p1', { description: 'new desc' });
    expect(updated.description).toBe('new desc');
    expect(updated.name).toBe('Project One');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    const reread = await storage.getProject('p1');
    expect(reread!.description).toBe('new desc');
  });

  it('updateProject throws when the project does not exist', async () => {
    await expect(storage.updateProject('missing', { name: 'x' })).rejects.toThrow(/Project missing not found/);
  });

  it('listProjects returns all projects', async () => {
    await storage.createProject(makeProject({ id: 'p1' }));
    await storage.createProject(makeProject({ id: 'p2', name: 'Two' }));
    const list = await storage.listProjects();
    expect(list.map(p => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('deleteProject removes the project and cascades child items', async () => {
    await storage.createProject(makeProject());
    await storage.createItem(makeItem({ id: 'a', projectId: 'p1' }));
    await storage.createItem(makeItem({ id: 'b', projectId: 'p1' }));
    expect(await storage.deleteProject('p1')).toBe(true);
    expect(await storage.getProject('p1')).toBeNull();
    expect(await storage.listItems({ projectId: 'p1' })).toEqual([]);
  });

  it('deleteProject returns false when nothing was deleted', async () => {
    expect(await storage.deleteProject('nope')).toBe(false);
  });
});

describe('SQLiteStorageProvider — Items', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb('items');
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    await storage.createProject(makeProject());
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanup(dbPath);
  });

  it('createItem appends a TODO→initial-status history entry even when none was provided', async () => {
    const created = await storage.createItem(makeItem({ status: Status.IN_PROGRESS }));
    expect(created.history).toBeDefined();
    expect(created.history!).toHaveLength(1);
    expect(created.history![0].fromStatus).toBe('TODO');
    expect(created.history![0].toStatus).toBe(Status.IN_PROGRESS);
    expect(created.history![0].timestamp).toBeInstanceOf(Date);
  });

  it('createItem appends to a provided history array (does not replace it)', async () => {
    const seed = {
      id: 'h0', fromStatus: Status.TODO, toStatus: Status.TODO, timestamp: new Date('2025-01-01T00:00:00Z'),
    };
    const created = await storage.createItem(makeItem({ history: [seed] }));
    expect(created.history!).toHaveLength(2);
    expect(created.history![0].id).toBe('h0');
  });

  it('getItem deserializes history timestamps as Dates', async () => {
    await storage.createItem(makeItem());
    const got = await storage.getItem('i1');
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.history![0].timestamp).toBeInstanceOf(Date);
  });

  it('getItem returns null for missing id', async () => {
    expect(await storage.getItem('nope')).toBeNull();
  });

  it('updateItem appends a history entry on status change', async () => {
    await storage.createItem(makeItem({ status: Status.IN_PROGRESS }));
    const updated = await storage.updateItem('i1', { status: Status.REVIEW });
    expect(updated.status).toBe(Status.REVIEW);
    expect(updated.history!).toHaveLength(2);
    expect(updated.history![1].fromStatus).toBe(Status.IN_PROGRESS);
    expect(updated.history![1].toStatus).toBe(Status.REVIEW);
  });

  it('updateItem skips history append when status is unchanged', async () => {
    await storage.createItem(makeItem({ status: Status.IN_PROGRESS }));
    const updated = await storage.updateItem('i1', { title: 'renamed' });
    expect(updated.title).toBe('renamed');
    expect(updated.history!).toHaveLength(1);
  });

  it('updateItem throws when item does not exist', async () => {
    await expect(storage.updateItem('missing', { title: 'x' })).rejects.toThrow(/Item missing not found/);
  });

  it('updateItem persists parentId changes to the indexed column', async () => {
    await storage.createItem(makeItem({ id: 'parent', type: ItemType.STORY, status: Status.IN_PROGRESS }));
    await storage.createItem(makeItem({ id: 'child', status: Status.IN_PROGRESS }));
    await storage.updateItem('child', { parentId: 'parent' });
    const children = await storage.listChildren('parent');
    expect(children.map(c => c.id)).toEqual(['child']);
  });

  it('listItems filters by projectId, type, status, and parentId', async () => {
    await storage.createProject(makeProject({ id: 'p2', name: 'Two' }));
    await storage.createItem(makeItem({ id: 'a', type: ItemType.STORY, status: Status.IN_PROGRESS }));
    await storage.createItem(makeItem({ id: 'b', type: ItemType.TASK,  status: Status.IN_PROGRESS, parentId: 'a' }));
    await storage.createItem(makeItem({ id: 'c', type: ItemType.TASK,  status: Status.REVIEW,      parentId: 'a' }));
    await storage.createItem(makeItem({ id: 'd', type: ItemType.TASK,  status: Status.IN_PROGRESS, projectId: 'p2' }));

    expect((await storage.listItems({ projectId: 'p1' })).map(i => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect((await storage.listItems({ type: ItemType.TASK })).map(i => i.id).sort()).toEqual(['b', 'c', 'd']);
    expect((await storage.listItems({ status: Status.REVIEW })).map(i => i.id)).toEqual(['c']);
    expect((await storage.listItems({ parentId: 'a' })).map(i => i.id).sort()).toEqual(['b', 'c']);
    expect((await storage.listItems({ projectId: 'p1', type: ItemType.TASK, status: Status.IN_PROGRESS })).map(i => i.id))
      .toEqual(['b']);
  });

  it('listItems honors limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await storage.createItem(makeItem({ id: `n${i}`, status: Status.IN_PROGRESS }));
    }
    expect(await storage.listItems({ limit: 2 })).toHaveLength(2);
    const page2 = await storage.listItems({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect(await storage.listItems({ offset: 4 })).toHaveLength(1);
  });

  it('listItems returns everything when no query is provided', async () => {
    await storage.createItem(makeItem({ id: 'a' }));
    await storage.createItem(makeItem({ id: 'b' }));
    expect(await storage.listItems()).toHaveLength(2);
  });

  it('deleteItem returns true on success and false when missing', async () => {
    await storage.createItem(makeItem());
    expect(await storage.deleteItem('i1')).toBe(true);
    expect(await storage.deleteItem('i1')).toBe(false);
    expect(await storage.getItem('i1')).toBeNull();
  });

  it('listChildren is empty for an unknown parent', async () => {
    expect(await storage.listChildren('nobody')).toEqual([]);
  });
});

describe('SQLiteStorageProvider — Snapshots', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb('snapshots');
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanup(dbPath);
  });

  it('createSnapshot persists fields and parses Dates on read', async () => {
    await storage.createSnapshot(makeSnapshot());
    const got = await storage.getSnapshot('s1');
    expect(got).not.toBeNull();
    expect(got!.itemId).toBe('i1');
    expect(got!.pausedAt).toBeInstanceOf(Date);
    expect(got!.resumedAt).toBeUndefined();
    expect(got!.filesModified).toEqual(['a.ts', 'b.ts']);
  });

  it('parses resumedAt as a Date when present', async () => {
    await storage.createSnapshot(makeSnapshot({ resumedAt: new Date('2026-02-01T00:00:00Z') }));
    const got = await storage.getSnapshot('s1');
    expect(got!.resumedAt).toBeInstanceOf(Date);
    expect(got!.resumedAt!.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('createSnapshot replaces any existing snapshot for the same itemId', async () => {
    await storage.createSnapshot(makeSnapshot({ id: 's1', summary: 'first' }));
    await storage.createSnapshot(makeSnapshot({ id: 's2', summary: 'second' }));
    expect(await storage.getSnapshot('s1')).toBeNull();
    const latest = await storage.getSnapshotByItemId('i1');
    expect(latest!.id).toBe('s2');
    expect(latest!.summary).toBe('second');
  });

  it('getSnapshot / getSnapshotByItemId return null when nothing matches', async () => {
    expect(await storage.getSnapshot('missing')).toBeNull();
    expect(await storage.getSnapshotByItemId('missing')).toBeNull();
  });

  it('deleteSnapshot returns true on success and false when missing', async () => {
    await storage.createSnapshot(makeSnapshot());
    expect(await storage.deleteSnapshot('s1')).toBe(true);
    expect(await storage.deleteSnapshot('s1')).toBe(false);
  });
});

describe('SQLiteStorageProvider — Flows', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb('flows');
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanup(dbPath);
  });

  it('createFlow + getFlow round-trip parses Dates', async () => {
    await storage.createFlow(makeFlow());
    const got = await storage.getFlow('flow-1');
    expect(got).not.toBeNull();
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.updatedAt).toBeInstanceOf(Date);
    expect(got!.steps).toHaveLength(3);
  });

  it('getFlow returns null when missing', async () => {
    expect(await storage.getFlow('missing')).toBeNull();
  });

  it('updateFlow merges fields and bumps updatedAt', async () => {
    await storage.createFlow(makeFlow());
    const before = (await storage.getFlow('flow-1'))!.updatedAt.getTime();
    const updated = await storage.updateFlow('flow-1', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((await storage.getFlow('flow-1'))!.name).toBe('Renamed');
  });

  it('updateFlow throws when the flow does not exist', async () => {
    await expect(storage.updateFlow('missing', { name: 'x' })).rejects.toThrow(/Flow missing not found/);
  });

  it('listFlows returns every stored flow', async () => {
    await storage.createFlow(makeFlow({ id: 'f1' }));
    await storage.createFlow(makeFlow({ id: 'f2', name: 'Other' }));
    expect((await storage.listFlows()).map(f => f.id).sort()).toEqual(['f1', 'f2']);
  });

  it('deleteFlow returns true on success and false when missing', async () => {
    await storage.createFlow(makeFlow());
    expect(await storage.deleteFlow('flow-1')).toBe(true);
    expect(await storage.deleteFlow('flow-1')).toBe(false);
  });
});
