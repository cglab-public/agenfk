// Tests for the user_key merge admin API (CGLAB-65):
//   POST /v1/admin/user-keys/merge { from, to }
//
// This is what "move an installation's events" actually means. Dashboards and
// rollups_daily are keyed on user_key — the lowercased git email, falling back
// to the OS username (routes/events.ts userKeyFor) — never on installation_id.
// So the real repair is re-attributing an identity: a changed git email, or an
// install with no git config that created a phantom osUser identity beside the
// real person. installation_id stays immutable provenance.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-merge-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

describe('user_key merge admin API', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  const addEvent = (id: string, userKey: string, day: string, installationId = 'inst-1') =>
    ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org-a', ?, ?, ?, ?, 'item.created', '{}')`,
      [id, installationId, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`],
    );

  // last_seen is 'now' by default: the guard only blocks on installations seen
  // inside the liveness window, so a seeded machine has to look active for the
  // live-key tests to exercise the path they describe. (CGLAB-72.)
  const seedInstallation = (id: string, gitEmail: string | null, lastSeen?: string) =>
    ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, 'org-a', '2026-01-01T00:00:00Z', ?, 'dev', null, ?)`,
      [id, lastSeen ?? new Date().toISOString(), gitEmail],
    );

  const seedApiKey = (tokenHash: string, installationId: string) =>
    ctx.db.run(
      `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, 'org-a', 'k', ?)`,
      [tokenHash, installationId],
    );

  const merge = (from: string, to: string, cookie = cookieAdmin) =>
    supertest(app).post('/v1/admin/user-keys/merge').set('Cookie', cookie).send({ from, to });

  const rollup = (userKey: string, day: string) =>
    ctx.db.get(
      'SELECT events_count FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?',
      ['org-a', userKey, day],
    );

  const eventKeys = async (): Promise<string[]> => {
    const rows = await ctx.db.all('SELECT user_key FROM events WHERE org_id = ? ORDER BY event_id', ['org-a']);
    return rows.map((r: any) => r.user_key);
  };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated requests', async () => {
      const r = await supertest(app).post('/v1/admin/user-keys/merge').send({ from: 'a@x', to: 'b@x' });
      expect(r.status).toBe(401);
    });

    it('rejects non-admin sessions', async () => {
      expect((await merge('a@x', 'b@x', cookieView)).status).toBe(403);
    });
  });

  describe('validation', () => {
    it('rejects a missing from/to', async () => {
      expect((await merge('', 'b@x')).status).toBe(400);
      expect((await merge('a@x', '')).status).toBe(400);
    });

    it('rejects merging a key onto itself', async () => {
      expect((await merge('a@x', 'a@x')).status).toBe(400);
    });

    it('normalizes case and whitespace before comparing', async () => {
      // '  A@X ' and 'a@x' are the same key, so this is still a self-merge.
      expect((await merge('  A@X ', 'a@x')).status).toBe(400);
    });
  });

  describe('re-attribution', () => {
    it('moves every event from the source key to the target', async () => {
      await addEvent('e1', 'dev', '2026-02-01');       // phantom osUser identity
      await addEvent('e2', 'dev', '2026-02-02');
      await addEvent('e3', 'dev@acme.com', '2026-02-02');

      const r = await merge('dev', 'dev@acme.com');

      expect(r.status).toBe(200);
      expect(r.body.eventsMoved).toBe(2);
      expect(await eventKeys()).toEqual(['dev@acme.com', 'dev@acme.com', 'dev@acme.com']);
    });

    it('leaves installation_id untouched — provenance is immutable', async () => {
      await addEvent('e1', 'dev', '2026-02-01', 'inst-old');

      await merge('dev', 'dev@acme.com');

      const row = await ctx.db.get('SELECT installation_id FROM events WHERE event_id = ?', ['e1']);
      expect(row.installation_id).toBe('inst-old');
    });

    it('repoints installations.git_email so the next event cannot resurrect the old key', async () => {
      await seedInstallation('inst-1', 'dev@old.com');
      await addEvent('e1', 'dev@old.com', '2026-02-01');

      await merge('dev@old.com', 'dev@acme.com');

      const row = await ctx.db.get('SELECT git_email FROM installations WHERE id = ?', ['inst-1']);
      expect(String(row.git_email).toLowerCase()).toBe('dev@acme.com');
      expect((await merge('dev@old.com', 'dev@acme.com')).body.eventsMoved).toBe(0);
    });

    it('does not touch another org', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
         VALUES ('e-b', 'org-b', 'inst-b', 'dev', '2026-02-01T09:00:00Z', '2026-02-01T09:00:00Z', 'item.created', '{}')`,
      );

      await merge('dev', 'dev@acme.com');

      const row = await ctx.db.get('SELECT user_key FROM events WHERE event_id = ?', ['e-b']);
      expect(row.user_key).toBe('dev');
    });
  });

  describe('osUser-derived keys (the phantom-identity case)', () => {
    it('merges a key containing uppercase, which userKeyFor never lowercases', async () => {
      // userKeyFor lowercases gitEmail only, so an osUser fallback key keeps its
      // case. Force-lowercasing the input made these keys unaddressable: the
      // UPDATE matched nothing and the endpoint answered 200 / eventsMoved 0.
      await addEvent('e1', 'Daniel', '2026-02-01');

      const r = await merge('Daniel', 'dev@acme.com');

      expect(r.status).toBe(200);
      expect(r.body.eventsMoved).toBe(1);
      expect(await eventKeys()).toEqual(['dev@acme.com']);
    });

    // A no-git-email machine derives 'osuser:<user>@<installation-prefix>', so
    // that — not the bare username — is the key the guard has to recognise. The
    // guard used to compare os_user to the bare form, matched nothing, and let
    // through exactly the merge it existed to refuse. (CGLAB-72.)
    const noEmailInstall = (lastSeen: string) => ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES ('aaaabbbb-1111-2222-3333', 'org-a', '2026-01-01T00:00:00Z', ?, 'dev', null, null)`,
      [lastSeen],
    );
    const recently = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const longAgo = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const NAMESPACED = 'osuser:dev@aaaabbbb';

    it('refuses while an active installation with no git email still holds a live key', async () => {
      await noEmailInstall(recently());
      await seedApiKey('hash-live', 'aaaabbbb-1111-2222-3333');
      await addEvent('e1', NAMESPACED, '2026-02-01');

      const r = await merge(NAMESPACED, 'dev@acme.com');

      expect(r.status).toBe(409);
      expect(await eventKeys()).toEqual([NAMESPACED]); // nothing moved
    });

    it('proceeds for a no-git-email installation once its key is revoked', async () => {
      await noEmailInstall(recently());
      await seedApiKey('hash-live', 'aaaabbbb-1111-2222-3333');
      await ctx.db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE token_hash = 'hash-live'");
      await addEvent('e1', NAMESPACED, '2026-02-01');

      expect((await merge(NAMESPACED, 'dev@acme.com')).status).toBe(200);
    });

    it('proceeds once that installation has been dormant past the liveness window', async () => {
      // A laptop nobody has opened in a week must not hold a repair hostage.
      // The alias written by the merge is what stops it resurrecting the key.
      await noEmailInstall(longAgo());
      await seedApiKey('hash-live', 'aaaabbbb-1111-2222-3333');
      await addEvent('e1', NAMESPACED, '2026-02-01');

      expect((await merge(NAMESPACED, 'dev@acme.com')).status).toBe(200);
      expect(await eventKeys()).toEqual(['dev@acme.com']);
    });
  });

  describe('rollups', () => {
    it('sums the two identities per day instead of colliding on the primary key', async () => {
      // Both keys have activity on the SAME day — a naive UPDATE of
      // rollups_daily would violate PK (org_id, user_key, day).
      await addEvent('e1', 'dev', '2026-02-01');
      await addEvent('e2', 'dev', '2026-02-01');
      await addEvent('e3', 'dev@acme.com', '2026-02-01');

      const r = await merge('dev', 'dev@acme.com');

      expect(r.status).toBe(200);
      expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(3);
    });

    it('removes the source identity from the dashboard entirely', async () => {
      await addEvent('e1', 'dev', '2026-02-01');
      await ctx.db.run(
        `INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES ('org-a', 'dev', '2026-02-01', 1)`,
      );

      await merge('dev', 'dev@acme.com');

      // The recompute alone can never do this: after the merge no event carries
      // the source key, so its upsert produces no group and the stale row would
      // survive forever.
      expect(await rollup('dev', '2026-02-01')).toBeFalsy();
    });

    it('repairs historical days, not just the most recent one', async () => {
      await addEvent('e-old', 'dev', '2025-06-15');
      await addEvent('e-new', 'dev', '2026-03-20');
      await ctx.db.run(
        `INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES ('org-a', 'anchor', '2026-03-20', 0)`,
      );

      await merge('dev', 'dev@acme.com');

      expect(Number((await rollup('dev@acme.com', '2025-06-15')).events_count)).toBe(1);
    });
  });

  describe('hidden_users handling', () => {
    it('drops a hidden source row without hiding the target person', async () => {
      await ctx.db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES ('org-a', 'dev')`);
      await addEvent('e1', 'dev', '2026-02-01');

      const r = await merge('dev', 'dev@acme.com');

      expect(r.body.sourceWasHidden).toBe(true);
      const src = await ctx.db.get('SELECT 1 AS x FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org-a', 'dev']);
      expect(src).toBeFalsy();
      // Inheriting the hide would silently stop ingest for a live developer.
      const tgt = await ctx.db.get('SELECT 1 AS x FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org-a', 'dev@acme.com']);
      expect(tgt).toBeFalsy();
    });

    it('reports sourceWasHidden false when it was not hidden', async () => {
      await addEvent('e1', 'dev', '2026-02-01');
      expect((await merge('dev', 'dev@acme.com')).body.sourceWasHidden).toBe(false);
    });

    it('leaves an already-hidden target hidden', async () => {
      await ctx.db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES ('org-a', 'dev@acme.com')`);
      await addEvent('e1', 'dev', '2026-02-01');

      await merge('dev', 'dev@acme.com');

      const tgt = await ctx.db.get('SELECT 1 AS x FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org-a', 'dev@acme.com']);
      expect(tgt).toBeTruthy();
    });
  });

  describe('live-key guard', () => {
    it('refuses while an installation on the source key still holds a live api_key', async () => {
      await seedInstallation('inst-1', 'dev@old.com');
      await seedApiKey('hash-live', 'inst-1');
      await addEvent('e1', 'dev@old.com', '2026-02-01');

      const r = await merge('dev@old.com', 'dev@acme.com');

      // Otherwise new events keep landing under the old key behind the merge.
      expect(r.status).toBe(409);
      expect(String(r.body.error)).toMatch(/live api key|retire|revoke/i);
      expect(await eventKeys()).toEqual(['dev@old.com']); // nothing moved
    });

    it('proceeds once those keys are revoked', async () => {
      await seedInstallation('inst-1', 'dev@old.com');
      await seedApiKey('hash-live', 'inst-1');
      await addEvent('e1', 'dev@old.com', '2026-02-01');
      await ctx.db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE token_hash = 'hash-live'");

      expect((await merge('dev@old.com', 'dev@acme.com')).status).toBe(200);
    });

    it('ignores a live key on an installation attributed to a different person', async () => {
      await seedInstallation('inst-other', 'someone@else.com');
      await seedApiKey('hash-other', 'inst-other');
      await addEvent('e1', 'dev', '2026-02-01');

      expect((await merge('dev', 'dev@acme.com')).status).toBe(200);
    });
  });

  describe('manual rollup repair', () => {
    it('lets an admin re-run the repair a crashed merge would have skipped', async () => {
      // The merge recomputes after its transaction commits and never retries,
      // so this is the only way back from a crash in between.
      await addEvent('e1', 'dev', '2026-02-01');
      await ctx.db.run('UPDATE events SET user_key = ? WHERE event_id = ?', ['dev@acme.com', 'e1']);

      const r = await supertest(app)
        .post('/v1/admin/rollups/recompute')
        .set('Cookie', cookieAdmin)
        .send({ since: '2026-01-01' });

      expect(r.status).toBe(200);
      expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(1);
    });

    it('accepts full: true', async () => {
      await addEvent('e1', 'dev@acme.com', '2025-01-01');
      const r = await supertest(app).post('/v1/admin/rollups/recompute').set('Cookie', cookieAdmin).send({ full: true });
      expect(r.status).toBe(200);
      expect(r.body.days).toBe(1);
    });

    it('rejects a malformed since', async () => {
      const r = await supertest(app).post('/v1/admin/rollups/recompute').set('Cookie', cookieAdmin).send({ since: 'yesterday' });
      expect(r.status).toBe(400);
    });

    it('rejects a viewer', async () => {
      const r = await supertest(app).post('/v1/admin/rollups/recompute').set('Cookie', cookieView).send({ full: true });
      expect(r.status).toBe(403);
    });
  });

  describe('idempotency and audit', () => {
    it('is idempotent — a second identical merge is a no-op success', async () => {
      await addEvent('e1', 'dev', '2026-02-01');

      const first = await merge('dev', 'dev@acme.com');
      const second = await merge('dev', 'dev@acme.com');

      expect(first.body.eventsMoved).toBe(1);
      expect(second.status).toBe(200);
      expect(second.body.eventsMoved).toBe(0);
      expect(Number((await rollup('dev@acme.com', '2026-02-01')).events_count)).toBe(1);
    });

    it('records who performed the merge, and from where to where', async () => {
      await addEvent('e1', 'dev', '2026-02-01');

      await merge('dev', 'dev@acme.com');

      const audit = await ctx.db.get(
        'SELECT from_user_key, to_user_key, merged_by_email, events_moved FROM user_key_merges WHERE org_id = ?',
        ['org-a'],
      );
      expect(audit.from_user_key).toBe('dev');
      expect(audit.to_user_key).toBe('dev@acme.com');
      expect(audit.merged_by_email).toBe('admin@x');
      expect(Number(audit.events_moved)).toBe(1);
    });

    it('succeeds with nothing to move when the source has no history', async () => {
      const r = await merge('ghost', 'dev@acme.com');
      expect(r.status).toBe(200);
      expect(r.body.eventsMoved).toBe(0);
    });
  });
});
