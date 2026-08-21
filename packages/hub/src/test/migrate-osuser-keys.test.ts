// One-time migration of historical bare-osUser keys (task cacb1aed).
//
// Existing events carry bare keys like 'dev'. Once ingest starts producing
// 'osuser:dev@<install>' the SAME machine would appear as two identities — the
// exact phantom split this story removes — so history has to be rewritten to
// match. A bare key shared by two machines correctly SPLITS into two, because it
// was never one person.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSqliteDb } from '../db/sqlite';
import { migrateOsUserKeys, OS_USER_KEY_MIGRATION } from '../services/migrateOsUserKeys';
import { recomputeRollups } from '../rollup';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-osusermig-${process.pid}.sqlite`);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('migrateOsUserKeys', () => {
  let db: any;

  const install = (id: string, gitEmail: string | null, osUser = 'dev') =>
    db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, 'org-a', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', ?, null, ?)`,
      [id, osUser, gitEmail],
    );

  const event = (id: string, installationId: string, userKey: string, day = '2026-02-01', orgId = 'org-a') =>
    db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, 'item.created', '{}')`,
      [id, orgId, installationId, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`],
    );

  const keyOf = async (eventId: string) =>
    (await db.get('SELECT user_key FROM events WHERE event_id = ?', [eventId]))?.user_key;

  const distinctKeys = async (): Promise<string[]> => {
    const rows = await db.all('SELECT DISTINCT user_key FROM events ORDER BY user_key');
    return rows.map((r: any) => r.user_key);
  };

  beforeEach(async () => {
    cleanup();
    db = await openSqliteDb(TEST_DB);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-a', 'A')");
  });

  afterEach(async () => { await db.close(); cleanup(); });

  it('rewrites a bare os-user key to the installation-scoped form', async () => {
    await install('inst-abc12345', null, 'dev');
    await event('e1', 'inst-abc12345', 'dev');

    const out = await migrateOsUserKeys(db);

    expect(await keyOf('e1')).toBe('osuser:dev@abc12345');
    expect(out.keysRewritten).toBe(1);
    expect(out.eventsRewritten).toBe(1);
  });

  it('splits a key shared by two installations into two identities', async () => {
    // The whole point: 'dev' on two laptops was never one person.
    await install('inst-alice111', null, 'dev');
    await install('inst-bob22222', null, 'dev');
    await event('e1', 'inst-alice111', 'dev');
    await event('e2', 'inst-bob22222', 'dev');

    const out = await migrateOsUserKeys(db);

    expect(await keyOf('e1')).not.toBe(await keyOf('e2'));
    expect(out.identitiesSplit).toBe(1);
    expect((await distinctKeys()).length).toBe(2);
  });

  it('leaves email keys completely alone', async () => {
    await install('inst-abc12345', 'dev@acme.com');
    await event('e1', 'inst-abc12345', 'dev@acme.com');

    const out = await migrateOsUserKeys(db);

    expect(await keyOf('e1')).toBe('dev@acme.com');
    expect(out.eventsRewritten).toBe(0);
  });

  it('does not re-namespace its own output', async () => {
    await install('inst-abc12345', null, 'dev');
    await event('e1', 'inst-abc12345', 'dev');
    await migrateOsUserKeys(db);

    const second = await migrateOsUserKeys(db, { force: true });

    expect(await keyOf('e1')).toBe('osuser:dev@abc12345');
    expect(second.eventsRewritten).toBe(0);
  });

  it('runs only once unless forced', async () => {
    await install('inst-abc12345', null, 'dev');
    await event('e1', 'inst-abc12345', 'dev');
    await migrateOsUserKeys(db);

    await event('e2', 'inst-abc12345', 'legacy');
    const second = await migrateOsUserKeys(db);

    expect(second.skipped).toBe(true);
    expect(await keyOf('e2')).toBe('legacy'); // untouched by the skipped run
  });

  it('records itself in system_state', async () => {
    await migrateOsUserKeys(db);

    const row = await db.get('SELECT value FROM system_state WHERE key = ?', [OS_USER_KEY_MIGRATION]);
    expect(row).toBeTruthy();
  });

  it('rebuilds rollups so dashboards match the rewritten history', async () => {
    await install('inst-abc12345', null, 'dev');
    await event('e1', 'inst-abc12345', 'dev', '2026-02-01');
    await recomputeRollups(db, { full: true });
    expect(await db.get('SELECT 1 AS x FROM rollups_daily WHERE user_key = ?', ['dev'])).toBeTruthy();

    await migrateOsUserKeys(db);

    // The stale identity must not linger: the recompute only rebuilds groups
    // that still have events, so its old rows have to be deleted outright.
    expect(await db.get('SELECT 1 AS x FROM rollups_daily WHERE user_key = ?', ['dev'])).toBeFalsy();
    const fresh = await db.get(
      'SELECT events_count FROM rollups_daily WHERE user_key = ? AND day = ?',
      ['osuser:dev@abc12345', '2026-02-01'],
    );
    expect(Number(fresh.events_count)).toBe(1);
  });

  it('repairs historical days, not only recent ones', async () => {
    await install('inst-abc12345', null, 'dev');
    await event('e-old', 'inst-abc12345', 'dev', '2025-06-15');

    await migrateOsUserKeys(db);

    const row = await db.get(
      'SELECT events_count FROM rollups_daily WHERE user_key = ? AND day = ?',
      ['osuser:dev@abc12345', '2025-06-15'],
    );
    expect(Number(row.events_count)).toBe(1);
  });

  it('migrates across orgs in one pass', async () => {
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
    await install('inst-abc12345', null, 'dev');
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES ('inst-def67890', 'org-b', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', 'dev', null, null)`,
    );
    await event('e1', 'inst-abc12345', 'dev');
    await event('e2', 'inst-def67890', 'dev', '2026-02-01', 'org-b');

    await migrateOsUserKeys(db);

    expect(await keyOf('e1')).toBe('osuser:dev@abc12345');
    expect(await keyOf('e2')).toBe('osuser:dev@def67890');
  });

  it('reports zero on an empty database without failing', async () => {
    const out = await migrateOsUserKeys(db);
    expect(out).toMatchObject({ keysRewritten: 0, eventsRewritten: 0, identitiesSplit: 0 });
  });

  it('carries an event whose installation is unknown rather than dropping it', async () => {
    // Defensive: provenance may reference an installation row that was never
    // created. Namespacing still works from the id itself.
    await event('e1', 'inst-orphan99', 'dev');

    await migrateOsUserKeys(db);

    expect(await keyOf('e1')).toBe('osuser:dev@orphan99');
  });
});
