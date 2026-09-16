// Upgrade path for flows.source gaining 'parent' (CGLAB-182).
//
// The column has always existed; it is the CHECK that changed, and SQLite
// cannot ALTER a CHECK — the table has to be rebuilt. An upgraded hub whose
// flows table still carries the two-value constraint refuses every dispatched
// flow with a constraint error, and the child installs nothing while reporting
// success at every other layer.
//
// So this boots a PRE-FEDERATION database. A fresh-database assertion cannot
// see this: a fresh hub gets the new CHECK from the schema block and passes
// whether or not the migration exists.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../db';
import { installDispatchedFlow } from '../services/federation/federationSync';

const DB = path.join(os.tmpdir(), `agenfk-hub-flowsource-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };
afterEach(cleanup);

/** A flows table from before federation: source allows only hub | community. */
function seedOldFlows(): void {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  raw.exec(`CREATE TABLE flows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','community')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by_user_id TEXT,
    org_available INTEGER NOT NULL DEFAULT 0
  );`);
  raw.exec(`INSERT INTO flows (id, org_id, name, definition_json, source, version, org_available)
            VALUES ('kept', 'org', 'Ours', '{"name":"Ours","steps":[]}', 'community', 4, 1)`);
  raw.close();
}

const dispatch = {
  kind: 'flow.dispatch' as const,
  dispatchId: 'd-1',
  flowVersion: 1,
  flow: { id: 'from-parent', name: 'Group TDD', description: null, version: 1,
          definition: { name: 'Group TDD', steps: [{ id: 'a', name: 'A', order: 0 }] } },
};

describe("an upgraded hub accepts a flow from its parent", () => {
  it('rebuilds the CHECK so a parent-origin flow can be stored at all', async () => {
    cleanup();
    seedOldFlows();
    const db = await openDb(DB);
    // The assertion that matters: without the rebuild this throws
    // SQLITE_CONSTRAINT and the child silently installs nothing.
    await installDispatchedFlow(db, 'org', dispatch);
    const row = await db.get<any>('SELECT source, org_available FROM flows WHERE id = ?', ['from-parent']);
    expect(row.source).toBe('parent');
    expect(Number(row.org_available)).toBe(1);
    await db.close();
  });

  it('carries the existing flows through the rebuild untouched', async () => {
    // A rebuild that loses rows is worse than the constraint error it fixes.
    cleanup();
    seedOldFlows();
    const db = await openDb(DB);
    const kept = await db.get<any>('SELECT name, source, version, org_available FROM flows WHERE id = ?', ['kept']);
    expect(kept).toMatchObject({ name: 'Ours', source: 'community', version: 4 });
    expect(Number(kept.org_available)).toBe(1);
    await db.close();
  });

  it('is safe to run twice, as every boot runs it', async () => {
    cleanup();
    seedOldFlows();
    await (await openDb(DB)).close();
    const db = await openDb(DB);
    const rows = await db.all<any>('SELECT id FROM flows');
    expect(rows.map((r: any) => r.id)).toEqual(['kept']);
    await installDispatchedFlow(db, 'org', dispatch);
    expect((await db.get<any>('SELECT source FROM flows WHERE id = ?', ['from-parent'])).source).toBe('parent');
    await db.close();
  });
});
