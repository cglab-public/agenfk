// Merge liveness and identity aliases, end to end (CGLAB-72).
//
// Both call sites — the Identities tab's blockedByLiveKey and the merge
// endpoint's own 409 — now share one predicate: an installation blocks a merge
// of <from> only if it CURRENTLY derives <from>, holds a non-revoked key, and
// was seen inside the liveness window. The two defects this replaces were
// mirror images. Suggestions over-blocked (a machine that had since acquired a
// git email, and so could never re-derive its old osuser: key, still counted),
// and the guard under-blocked (it compared a bare username against namespaced
// keys, so the branch written for exactly this case matched nothing).
//
// Dropping dormant machines from the check means a waking machine could
// otherwise re-derive a key that was merged away, so a merge now records a
// user_key_aliases row and ingest resolves through it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-mergelive-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

describe('merge liveness and identity aliases (CGLAB-72)', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let ingestToken: string;

  /** An installation, with control over when it was last seen. */
  const install = (
    id: string,
    gitEmail: string | null,
    osUser = 'dev',
    lastSeen = hoursAgo(1),
  ) =>
    ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, 'org-a', '2026-01-01T00:00:00Z', ?, ?, null, ?)`,
      [id, lastSeen, osUser, gitEmail],
    );

  const event = (id: string, installationId: string, userKey: string, day = '2026-02-01') =>
    ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org-a', ?, ?, ?, ?, 'item.created', '{}')`,
      [id, installationId, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`],
    );

  const liveKey = (hash: string, installationId: string) =>
    ctx.db.run(
      `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, 'org-a', 'k', ?)`,
      [hash, installationId],
    );

  const suggestions = () =>
    supertest(app).get('/v1/admin/identity-suggestions').set('Cookie', cookie);

  const merge = (from: string, to: string) =>
    supertest(app).post('/v1/admin/user-keys/merge').set('Cookie', cookie).send({ from, to });

  const aliases = () =>
    ctx.db.all('SELECT alias_key, canonical_key, merge_id FROM user_key_aliases WHERE org_id = ? ORDER BY alias_key', ['org-a']);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
    ingestToken = await issueApiKey(ctx.db, 'org-a', 'ingest');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // ── Defect 1: the Identities tab blocked merges that were already safe ────

  describe('blockedByLiveKey asks what the installation derives TODAY', () => {
    it('does not block when the installation now has a git email, live key and all', async () => {
      // The machine's history is under 'osuser:gcs@...', but with git_email set
      // userKeyFor returns the email — the source key can never come back, so
      // the merge is safe and retiring an active developer's install would be
      // destructive for nothing. This is the production false positive.
      await install('d13762b1-1111-2222-3333-444455556666', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'd13762b1-1111-2222-3333-444455556666', 'osuser:gcs@d13762b1');
      await liveKey('hash-live', 'd13762b1-1111-2222-3333-444455556666');

      const row = (await suggestions()).body[0];
      expect(row.from).toBe('osuser:gcs@d13762b1');
      expect(row.blockedByLiveKey).toBe(false);
    });

    it('blocks when another installation still reports the source key and is live', async () => {
      // The reachable case: a developer changed git email. The old laptop is
      // still configured with old@ and still ingesting, so merging old@ onto
      // new@ really would undo itself on its next event.
      await emailChangeSetup(hoursAgo(1));

      const row = (await suggestions()).body.find((s: any) => s.from === 'old@cglab.com');
      expect(row.blockedByLiveKey).toBe(true);
      expect(row.blockingInstallations).toEqual(['aaaaaaaa-1111-2222-3333-444455556666']);
    });
  });

  /**
   * One developer, two machines, mid email change. The old machine still
   * derives old@cglab.com; the new one has already moved to new@cglab.com but
   * carries history under the old key, which is what makes it a suggestion.
   */
  const emailChangeSetup = async (oldMachineLastSeen: string) => {
    await install('aaaaaaaa-1111-2222-3333-444455556666', 'old@cglab.com', 'dev', oldMachineLastSeen);
    await install('bbbbbbbb-1111-2222-3333-444455556666', 'new@cglab.com', 'dev');
    await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'old@cglab.com');
    await event('e2', 'bbbbbbbb-1111-2222-3333-444455556666', 'old@cglab.com');
    await liveKey('hash-live', 'aaaaaaaa-1111-2222-3333-444455556666');
  };

  describe('liveness is scoped to the last 48h', () => {
    const blockedAfter = async (lastSeen: string) => {
      await emailChangeSetup(lastSeen);
      return (await suggestions()).body
        .find((s: any) => s.from === 'old@cglab.com').blockedByLiveKey;
    };

    it('does not block on an installation dormant for a week, live key or not', async () => {
      expect(await blockedAfter(hoursAgo(24 * 7))).toBe(false);
    });

    it('still blocks just inside the window', async () => {
      expect(await blockedAfter(hoursAgo(47))).toBe(true);
    });

    it('stops blocking just outside it', async () => {
      expect(await blockedAfter(hoursAgo(49))).toBe(false);
    });
  });

  // ── Defect 2: the merge guard never matched a namespaced key ──────────────

  describe('the merge guard covers namespaced osuser keys', () => {
    it('409s on a live, recently seen installation that still derives the key', async () => {
      // Before the fix the guard compared os_user ('dev') to the namespaced
      // key and matched nothing, so this merge committed and the next event
      // silently undid it.
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev');
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await liveKey('hash-live', 'aaaaaaaa-1111-2222-3333-444455556666');

      const r = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/live api key/i);
    });

    it('allows the merge once that installation has been dormant past the window', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await liveKey('hash-live', 'aaaaaaaa-1111-2222-3333-444455556666');

      const r = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      expect(r.status).toBe(200);
      expect(r.body.eventsMoved).toBe(1);
    });

    it('allows the merge when the installation now derives a different key', async () => {
      await install('d13762b1-1111-2222-3333-444455556666', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'd13762b1-1111-2222-3333-444455556666', 'osuser:gcs@d13762b1');
      await liveKey('hash-live', 'd13762b1-1111-2222-3333-444455556666');

      const r = await merge('osuser:gcs@d13762b1', 'guilherme@cglab.com');
      expect(r.status).toBe(200);
      expect(r.body.eventsMoved).toBe(1);
    });

    it('still 409s on the email case the guard already covered', async () => {
      await install('bbbbbbbb-1111-2222-3333-444455556666', 'old@cglab.com', 'dev');
      await event('e1', 'bbbbbbbb-1111-2222-3333-444455556666', 'old@cglab.com');
      await liveKey('hash-live', 'bbbbbbbb-1111-2222-3333-444455556666');

      expect((await merge('old@cglab.com', 'new@cglab.com')).status).toBe(409);
    });

    it('does not 409 on a revoked key, however recently the machine was seen', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev');
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await liveKey('hash-live', 'aaaaaaaa-1111-2222-3333-444455556666');
      await ctx.db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE token_hash = 'hash-live'");

      expect((await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com')).status).toBe(200);
    });

    it('names the blocking installations so the admin knows what to act on', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev');
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await liveKey('hash-live', 'aaaaaaaa-1111-2222-3333-444455556666');

      const r = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      expect(r.body.installations).toEqual(['aaaaaaaa-1111-2222-3333-444455556666']);
    });
  });

  // ── Aliases: a dormant machine must not resurrect a merged-away key ───────

  describe('a merge records an alias', () => {
    it('writes one alias row stamped with the merge that created it', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');

      const r = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      const rows = await aliases();
      expect(rows).toHaveLength(1);
      expect(rows[0].alias_key).toBe('osuser:dev@aaaaaaaa');
      expect(rows[0].canonical_key).toBe('dana@cglab.com');
      expect(rows[0].merge_id).toBe(r.body.mergeId);
    });

    it('maps a waking dormant machine onto the merged identity at ingest', async () => {
      // The whole point of the 48h window: this machine no longer blocks the
      // merge, so it must not be able to undo it either.
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      expect((await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com')).status).toBe(200);

      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({ events: [{
          eventId: 'woken-1',
          installationId: 'aaaaaaaa-1111-2222-3333-444455556666',
          orgId: 'org-a',
          occurredAt: '2026-08-20T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: null },
          type: 'item.created',
          payload: {},
        }] });
      expect(r.status).toBe(200);
      expect(r.body.ingested).toBe(1);

      const stored = await ctx.db.get(
        'SELECT user_key FROM events WHERE event_id = ?', ['woken-1'],
      );
      expect((stored as any).user_key).toBe('dana@cglab.com');
      // And no resurrected identity beside it.
      const keys = await ctx.db.all(
        'SELECT DISTINCT user_key FROM events WHERE org_id = ?', ['org-a'],
      );
      expect(keys.map((k: any) => k.user_key)).toEqual(['dana@cglab.com']);
    });

    it('follows a chain when the target is itself merged onward', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await event('e2', 'aaaaaaaa-1111-2222-3333-444455556666', 'old@cglab.com');
      await merge('osuser:dev@aaaaaaaa', 'old@cglab.com');
      await merge('old@cglab.com', 'new@cglab.com');

      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({ events: [{
          eventId: 'woken-2',
          installationId: 'aaaaaaaa-1111-2222-3333-444455556666',
          orgId: 'org-a',
          occurredAt: '2026-08-20T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: null },
          type: 'item.created',
          payload: {},
        }] });
      expect(r.status).toBe(200);

      const stored = await ctx.db.get(
        'SELECT user_key FROM events WHERE event_id = ?', ['woken-2'],
      );
      expect((stored as any).user_key).toBe('new@cglab.com');
    });

    it('drops an aliased event when the CANONICAL identity is hidden', async () => {
      // Hiding is applied to the person, so it must be evaluated after the
      // alias resolves — otherwise a merged-away key is a hole in the rule.
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org-a', 'dana@cglab.com']);

      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({ events: [{
          eventId: 'woken-3',
          installationId: 'aaaaaaaa-1111-2222-3333-444455556666',
          orgId: 'org-a',
          occurredAt: '2026-08-20T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: null },
          type: 'item.created',
          payload: {},
        }] });
      expect(r.body.ingested).toBe(0);
      expect(r.body.hiddenDropped).toBe(1);
    });

    it('keeps aliases per org', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');

      const other = await ctx.db.all(
        'SELECT alias_key FROM user_key_aliases WHERE org_id = ?', ['org-b'],
      );
      expect(other).toEqual([]);
    });
  });

  describe('merging onto an already-merged identity follows it', () => {
    it('lands history where ingest would send new events, and says so', async () => {
      // Otherwise the identity splits: history on the stale target, new events
      // forwarded past it by the alias map.
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await install('bbbbbbbb-1111-2222-3333-444455556666', null, 'ops', hoursAgo(24 * 7));
      await event('e1', 'bbbbbbbb-1111-2222-3333-444455556666', 'old@cglab.com');
      await merge('old@cglab.com', 'new@cglab.com');

      await event('e2', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      const r = await merge('osuser:dev@aaaaaaaa', 'old@cglab.com');

      expect(r.status).toBe(200);
      expect(r.body.to).toBe('new@cglab.com');
      expect(r.body.requestedTo).toBe('old@cglab.com');
      const moved = await ctx.db.get('SELECT user_key FROM events WHERE event_id = ?', ['e2']);
      expect((moved as any).user_key).toBe('new@cglab.com');
    });

    it('leaves the response target alone for an ordinary merge', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');

      const r = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      expect(r.body.to).toBe('dana@cglab.com');
      expect(r.body.requestedTo).toBeUndefined();
    });
  });

  describe('reverting a merge removes the alias it created', () => {
    it('lets the old identity exist again after a revert', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      const m = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      expect(await aliases()).toHaveLength(1);

      const rev = await supertest(app)
        .post(`/v1/admin/user-keys/merges/${m.body.mergeId}/revert`)
        .set('Cookie', cookie).send({});
      expect(rev.status).toBe(200);
      expect(rev.body.aliasesRemoved).toBe(1);
      expect(await aliases()).toEqual([]);
    });

    it('removes only the aliases its own merge wrote', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await install('bbbbbbbb-1111-2222-3333-444455556666', null, 'ops', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      await event('e2', 'bbbbbbbb-1111-2222-3333-444455556666', 'osuser:ops@bbbbbbbb');
      const first = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      await merge('osuser:ops@bbbbbbbb', 'oscar@cglab.com');

      await supertest(app)
        .post(`/v1/admin/user-keys/merges/${first.body.mergeId}/revert`)
        .set('Cookie', cookie).send({});

      const rows = await aliases();
      expect(rows).toHaveLength(1);
      expect(rows[0].alias_key).toBe('osuser:ops@bbbbbbbb');
    });

    it('lets a reverted key be re-derived at ingest again', async () => {
      await install('aaaaaaaa-1111-2222-3333-444455556666', null, 'dev', hoursAgo(24 * 7));
      await event('e1', 'aaaaaaaa-1111-2222-3333-444455556666', 'osuser:dev@aaaaaaaa');
      const m = await merge('osuser:dev@aaaaaaaa', 'dana@cglab.com');
      await supertest(app)
        .post(`/v1/admin/user-keys/merges/${m.body.mergeId}/revert`)
        .set('Cookie', cookie).send({});

      await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${ingestToken}`)
        .send({ events: [{
          eventId: 'woken-4',
          installationId: 'aaaaaaaa-1111-2222-3333-444455556666',
          orgId: 'org-a',
          occurredAt: '2026-08-20T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: null },
          type: 'item.created',
          payload: {},
        }] });

      const stored = await ctx.db.get(
        'SELECT user_key FROM events WHERE event_id = ?', ['woken-4'],
      );
      expect((stored as any).user_key).toBe('osuser:dev@aaaaaaaa');
    });
  });
});
