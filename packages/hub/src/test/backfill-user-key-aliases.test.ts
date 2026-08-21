// Backfilling aliases for merges made before the table existed (CGLAB-76).
//
// The alias table shipped alongside the liveness window: a dormant machine no
// longer blocks a merge, so the alias is what stops it waking later and
// resurrecting the key. Merges performed before that release have no alias, so
// the invariant does not hold for them — which a production hub hit immediately,
// with three live merges and an empty table.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { backfillUserKeyAliases, ALIAS_BACKFILL_MIGRATION } from '../services/backfillUserKeyAliases';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-aliasbackfill-${process.pid}.sqlite`);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('user_key_aliases backfill', () => {
  let db: HubDb;

  const merge = (
    id: string, from: string, to: string,
    opts: { org?: string; revertedAt?: string | null; createdAt?: string } = {},
  ) => db.run(
    `INSERT INTO user_key_merges (id, org_id, from_user_key, to_user_key, events_moved, reverted_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [id, opts.org ?? 'org-a', from, to, opts.revertedAt ?? null, opts.createdAt ?? '2026-08-01T00:00:00Z'],
  );

  const aliases = () => db.all<{ alias_key: string; canonical_key: string; merge_id: string; org_id: string }>(
    'SELECT org_id, alias_key, canonical_key, merge_id FROM user_key_aliases ORDER BY org_id, alias_key',
  );

  beforeEach(async () => {
    cleanup();
    db = await openDb(TEST_DB);
  });

  afterEach(async () => { await db.close(); cleanup(); });

  it('gives an un-aliased historical merge the protection it never had', async () => {
    await merge('m1', 'osuser:gcs@d13762b1', 'guilherme@cglab.com');

    const r = await backfillUserKeyAliases(db);

    expect(r.aliasesWritten).toBe(1);
    expect(await aliases()).toEqual([{
      org_id: 'org-a',
      alias_key: 'osuser:gcs@d13762b1',
      canonical_key: 'guilherme@cglab.com',
      merge_id: 'm1',
    }]);
  });

  it('stamps the originating merge, so reverting that merge still removes it', async () => {
    // Without the right merge_id the backfilled alias would be unreachable by
    // revert, making a previously-revertible merge permanently sticky.
    await merge('m1', 'a@x.com', 'b@x.com');
    await backfillUserKeyAliases(db);

    const removed = await db.run('DELETE FROM user_key_aliases WHERE org_id = ? AND merge_id = ?', ['org-a', 'm1']);
    expect(removed.changes).toBe(1);
  });

  it('skips a merge that was already reverted', async () => {
    await merge('m1', 'a@x.com', 'b@x.com', { revertedAt: '2026-08-02T00:00:00Z' });

    const r = await backfillUserKeyAliases(db);

    expect(r.aliasesWritten).toBe(0);
    expect(await aliases()).toEqual([]);
  });

  describe('a source merged more than once', () => {
    // Refusing to re-merge an already-merged key is newer than the merge
    // endpoint, so two un-reverted merges CAN share a source. A plain
    // INSERT..SELECT..DO NOTHING keeps whichever row the query emitted first.
    it('uses the LATEST un-reverted merge, not whichever comes first', async () => {
      await merge('m-old', 'a@x.com', 'stale@x.com', { createdAt: '2026-08-01T00:00:00Z' });
      await merge('m-new', 'a@x.com', 'current@x.com', { createdAt: '2026-08-05T00:00:00Z' });

      const r = await backfillUserKeyAliases(db);

      expect(r.aliasesWritten).toBe(1);
      expect(r.supersededSources).toBe(1);
      const rows = await aliases();
      expect(rows[0].canonical_key).toBe('current@x.com');
      expect(rows[0].merge_id).toBe('m-new');
    });

    it('still picks the latest when the rows arrive newest-first', async () => {
      // Guards against the answer depending on row order rather than on time.
      await merge('m-new', 'a@x.com', 'current@x.com', { createdAt: '2026-08-05T00:00:00Z' });
      await merge('m-old', 'a@x.com', 'stale@x.com', { createdAt: '2026-08-01T00:00:00Z' });

      await backfillUserKeyAliases(db);

      expect((await aliases())[0].canonical_key).toBe('current@x.com');
    });
  });

  describe('canonicalisation', () => {
    // Older merges stored `from` exactly as an admin typed it. Ingest only ever
    // derives the lowercased form, so a verbatim alias can never match.
    it('lowercases an email-shaped alias so ingest can actually hit it', async () => {
      await merge('m1', 'Old@CGLab.com', 'New@CGLab.com');

      const r = await backfillUserKeyAliases(db);

      expect(r.canonicalised).toBe(1);
      const rows = await aliases();
      expect(rows[0].alias_key).toBe('old@cglab.com');
      expect(rows[0].canonical_key).toBe('new@cglab.com');
    });

    it('preserves osUser case, because Windows accounts are named that way', async () => {
      await merge('m1', 'osuser:DPolistchuck@aaaabbbb', 'daniel@cglab.com');

      await backfillUserKeyAliases(db);

      expect((await aliases())[0].alias_key).toBe('osuser:DPolistchuck@aaaabbbb');
    });

    it('treats two case-variant merges of one identity as the same source', async () => {
      await merge('m-old', 'old@cglab.com', 'a@x.com', { createdAt: '2026-08-01T00:00:00Z' });
      await merge('m-new', 'Old@CGLab.com', 'b@x.com', { createdAt: '2026-08-05T00:00:00Z' });

      const r = await backfillUserKeyAliases(db);

      expect(r.aliasesWritten).toBe(1);
      expect((await aliases())[0].canonical_key).toBe('b@x.com');
    });

    it('writes no self-alias when the two keys differ only by case', async () => {
      // resolveAliasKey would otherwise loop on itself for no gain.
      await merge('m1', 'Dev@X.com', 'dev@x.com');

      const r = await backfillUserKeyAliases(db);

      expect(r.aliasesWritten).toBe(0);
      expect(await aliases()).toEqual([]);
    });
  });

  it('never overwrites an alias a live merge already wrote', async () => {
    // A row written at merge time is newer and more authoritative than anything
    // reconstructed from the journal.
    await merge('m1', 'a@x.com', 'from-history@x.com');
    await db.run(
      `INSERT INTO user_key_aliases (org_id, alias_key, canonical_key, merge_id)
       VALUES ('org-a', 'a@x.com', 'from-live-merge@x.com', 'm-live')`,
    );

    await backfillUserKeyAliases(db);

    const rows = await aliases();
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_key).toBe('from-live-merge@x.com');
    expect(rows[0].merge_id).toBe('m-live');
  });

  it('keeps each org\'s merges to itself', async () => {
    await merge('m-a', 'shared@x.com', 'a-target@x.com', { org: 'org-a' });
    await merge('m-b', 'shared@x.com', 'b-target@x.com', { org: 'org-b' });

    const r = await backfillUserKeyAliases(db);

    expect(r.aliasesWritten).toBe(2);
    const rows = await aliases();
    expect(rows.map(x => [x.org_id, x.canonical_key])).toEqual([
      ['org-a', 'a-target@x.com'],
      ['org-b', 'b-target@x.com'],
    ]);
  });

  describe('runs once', () => {
    it('marks itself done and skips on a second boot', async () => {
      await merge('m1', 'a@x.com', 'b@x.com');
      await backfillUserKeyAliases(db);

      const second = await backfillUserKeyAliases(db);
      expect(second.skipped).toBe(true);

      const state = await db.get('SELECT value FROM system_state WHERE key = ?', [ALIAS_BACKFILL_MIGRATION]);
      expect(state).toBeTruthy();
    });

    it('does not re-add an alias a later revert deliberately removed', async () => {
      // The dangerous shape: run, revert a merge, boot again. Re-adding would
      // silently undo an admin's revert.
      await merge('m1', 'a@x.com', 'b@x.com');
      await backfillUserKeyAliases(db);
      await db.run('DELETE FROM user_key_aliases WHERE merge_id = ?', ['m1']);
      await db.run("UPDATE user_key_merges SET reverted_at = '2026-08-09T00:00:00Z' WHERE id = 'm1'");

      await backfillUserKeyAliases(db);

      expect(await aliases()).toEqual([]);
    });

    it('reports nothing to do on a hub with no merges at all', async () => {
      const r = await backfillUserKeyAliases(db);
      expect(r).toMatchObject({ skipped: false, aliasesWritten: 0, supersededSources: 0, canonicalised: 0 });
    });
  });
});
