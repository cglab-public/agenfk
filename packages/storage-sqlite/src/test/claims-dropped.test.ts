/**
 * @file 26c059f6 — the `claims` field cards carried is dropped from the database.
 *
 * Claims were removed: nothing reads the field, the API no longer accepts it,
 * and leaving it on the rows would ship a dead field in every GET /items. The
 * provider drops it from existing rows once, at init, and touches nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem } from '@agenfk/core';
// The provider's own driver (Node 22+), for reading rows as they are stored.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;
beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `agenfk-noclaims-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});
afterEach(async () => {
  await storage.shutdown();
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
});

const item = (id: string, description = ''): AgEnFKItem => ({
  id, projectId: 'p1', type: ItemType.TASK, status: Status.TODO, title: 'card', description, createdAt: new Date(), updatedAt: new Date(), history: [], comments: [], tests: [], tokenUsage: [], context: [],
} as unknown as AgEnFKItem);
const raw = (id: string): string => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare('SELECT data FROM items WHERE id = ?').get(id) as { data: string }).data; } finally { db.close(); }
};
/** Write a row the way an older build left it, then open the database again. */
async function reopenWith(id: string, patch: Record<string, unknown>): Promise<void> {
  await storage.shutdown();
  const db = new DatabaseSync(dbPath);
  const data = JSON.parse((db.prepare('SELECT data FROM items WHERE id = ?').get(id) as { data: string }).data);
  db.prepare('UPDATE items SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, ...patch }), id);
  db.close();
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
}

describe('an old card that carries claims', () => {
  it('has the field dropped at init, and keeps everything else', async () => {
    await storage.createItem(item('old-1'));
    await reopenWith('old-1', { claims: ['packages/ui/', 'src/App.tsx'], branchName: 'feat/x' });
    const row = JSON.parse(raw('old-1'));
    expect(row.claims, 'the claims field survived init').toBeUndefined();
    expect(row.branchName).toBe('feat/x');
    expect(((await storage.getItem('old-1')) as any).claims).toBeUndefined();
  });

  it('drops an empty claims list too', async () => {
    await storage.createItem(item('old-2'));
    await reopenWith('old-2', { claims: [] });
    expect(JSON.parse(raw('old-2')).claims).toBeUndefined();
  });
});

describe('a card with no claims field', () => {
  it('is left byte for byte as it was, even when its text mentions "claims"', async () => {
    await storage.createItem(item('plain', 'The doc says {"claims": ["x"]} somewhere.'));
    await storage.shutdown();
    const before = raw('plain');
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    expect(raw('plain')).toBe(before);
  });

  it('keeps a nested "claims" key: only the card\'s own top-level field goes', async () => {
    // The scan's LIKE matches this row; the card itself carries no claims field.
    await storage.createItem(item('nested'));
    await reopenWith('nested', { context: [{ path: 'notes.json', meta: { claims: ['x'] } }] });
    const row = JSON.parse(raw('nested'));
    expect(row.claims).toBeUndefined();
    expect(row.context[0].meta.claims, 'a nested key was taken for the retired field').toEqual(['x']);
  });
});
