// Revertible identity merges (BUG 098f8ba7).
//
// A merge rewrites history. The audit row recorded only counts, so a mistaken
// merge — attributing one person's work to another — was permanent. The
// Identities tab makes merging one click, so the provenance to undo it has to be
// stamped onto the rows as they move.
//
// Semantics are LIFO by construction: an event carries only its LAST merge, so
// reverting an older merge after a newer one touched the same rows must report
// that it moved nothing rather than silently claiming success.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-unmerge-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('reverting an identity merge', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  const event = (id: string, userKey: string, day = '2026-02-01', installationId = 'inst-1') =>
    ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org-a', ?, ?, ?, ?, 'item.created', '{}')`,
      [id, installationId, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`],
    );

  const merge = (from: string, to: string) =>
    supertest(app).post('/v1/admin/user-keys/merge').set('Cookie', cookieAdmin).send({ from, to });

  const revert = (id: string, cookie = cookieAdmin) =>
    supertest(app).post(`/v1/admin/user-keys/merges/${encodeURIComponent(id)}/revert`).set('Cookie', cookie);

  const keyOf = async (eventId: string) =>
    (await ctx.db.get('SELECT user_key FROM events WHERE event_id = ?', [eventId]))?.user_key;

  const rollup = (userKey: string, day: string) =>
    ctx.db.get('SELECT events_count FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?',
      ['org-a', userKey, day]);

  const merges = () => supertest(app).get('/v1/admin/user-keys/merges').set('Cookie', cookieAdmin);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    cookieView = (await supertest(app).post('/auth/login').send({ email: 'view@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated and non-admin', async () => {
      expect((await supertest(app).post('/v1/admin/user-keys/merges/x/revert')).status).toBe(401);
      expect((await revert('x', cookieView)).status).toBe(403);
    });
  });

  describe('restoring the moved events', () => {
    it('puts the events back under their original identity', async () => {
      await event('e1', 'dev');
      await event('e2', 'dev');
      const m = await merge('dev', 'dev@acme.com');
      expect(await keyOf('e1')).toBe('dev@acme.com');

      const r = await revert(m.body.mergeId);

      expect(r.status).toBe(200);
      expect(r.body.eventsRestored).toBe(2);
      expect(await keyOf('e1')).toBe('dev');
      expect(await keyOf('e2')).toBe('dev');
    });

    it('leaves the target identity own events alone', async () => {
      // Only what the merge moved comes back — this is the whole reason the
      // provenance is stamped per event rather than inferred from a timestamp.
      await event('moved', 'dev');
      await event('native', 'dev@acme.com');
      const m = await merge('dev', 'dev@acme.com');

      await revert(m.body.mergeId);

      expect(await keyOf('moved')).toBe('dev');
      expect(await keyOf('native')).toBe('dev@acme.com');
    });

    it('rebuilds the rollups for both identities', async () => {
      await event('e1', 'dev', '2026-02-01');
      await event('e2', 'dev@acme.com', '2026-02-01');
      const m = await merge('dev', 'dev@acme.com');
      expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(2);

      await revert(m.body.mergeId);

      expect(Number((await rollup('dev', '2026-02-01')).events_count)).toBe(1);
      expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(1);
    });

    it('repairs historical days, not just recent ones', async () => {
      await event('e-old', 'dev', '2025-06-15');
      const m = await merge('dev', 'dev@acme.com');

      await revert(m.body.mergeId);

      expect(Number((await rollup('dev', '2025-06-15')).events_count)).toBe(1);
    });

    it('restores the installations git_email so the next event does not re-merge', async () => {
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES ('inst-1', 'org-a', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', 'dev', null, 'old@acme.com')`,
      );
      await event('e1', 'old@acme.com');
      const m = await merge('old@acme.com', 'new@acme.com');

      await revert(m.body.mergeId);

      const row = await ctx.db.get('SELECT git_email FROM installations WHERE id = ?', ['inst-1']);
      expect(String(row.git_email).toLowerCase()).toBe('old@acme.com');
    });
  });

  describe('audit trail', () => {
    it('marks the merge reverted rather than deleting it', async () => {
      await event('e1', 'dev');
      const m = await merge('dev', 'dev@acme.com');

      await revert(m.body.mergeId);

      const list = await merges();
      const row = list.body.find((x: any) => x.id === m.body.mergeId);
      expect(row).toBeTruthy();
      expect(row.revertedAt).toBeTruthy();
    });

    it('refuses to revert the same merge twice', async () => {
      await event('e1', 'dev');
      const m = await merge('dev', 'dev@acme.com');
      await revert(m.body.mergeId);

      const second = await revert(m.body.mergeId);

      expect(second.status).toBe(409);
      expect(await keyOf('e1')).toBe('dev'); // unchanged by the refusal
    });

    it('404s an unknown merge id', async () => {
      expect((await revert('no-such-merge')).status).toBe(404);
    });

    it('404s a merge belonging to another org', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await ctx.db.run(
        `INSERT INTO user_key_merges (id, org_id, from_user_key, to_user_key, events_moved)
         VALUES ('m-b', 'org-b', 'x', 'y', 1)`,
      );

      expect((await revert('m-b')).status).toBe(404);
    });
  });

  describe('LIFO semantics', () => {
    it('reports that nothing moved when a newer merge has since claimed the events', async () => {
      await event('e1', 'a');
      const first = await merge('a', 'b');
      const second = await merge('b', 'c');
      expect(await keyOf('e1')).toBe('c');

      const r = await revert(first.body.mergeId);

      // Honest zero rather than a silent success: the rows now belong to the
      // later merge, and reverting out of order would corrupt the chain.
      expect(r.status).toBe(200);
      expect(r.body.eventsRestored).toBe(0);
      expect(String(r.body.note ?? '')).toMatch(/newer|later|superseded/i);
      expect(await keyOf('e1')).toBe('c');
    });

    it('unwinds a chain correctly in reverse order', async () => {
      await event('e1', 'a');
      const first = await merge('a', 'b');
      const second = await merge('b', 'c');

      await revert(second.body.mergeId);
      expect(await keyOf('e1')).toBe('b');
      await revert(first.body.mergeId);

      expect(await keyOf('e1')).toBe('a');
    });
  });

  describe('the merge response exposes its own id', () => {
    it('returns mergeId so a revert is possible without a second lookup', async () => {
      await event('e1', 'dev');
      const m = await merge('dev', 'dev@acme.com');
      expect(typeof m.body.mergeId).toBe('string');
      expect(m.body.mergeId.length).toBeGreaterThan(10);
    });
  });
});
