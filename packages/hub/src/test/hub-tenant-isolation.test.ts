// Privilege and tenant boundaries on the hub (CGLAB-75).
//
// Found by adversarial security review. All three predate the endpoint-lifecycle
// epic and are live in production.
//
// The hub has two trust boundaries that matter here. The first is role: a
// `viewer` is deliberately read-only, so anything that hands one a bearer token
// is an escalation. The second is tenancy: `installations.id` and
// `upgrade_directives.id` are GLOBAL primary keys, so holding a valid key for
// your own org must not let you read or write another org's rows — being a
// trusted insider in org A says nothing about org B.
//
// Note what is deliberately NOT tested here: an event's `actor` block is not
// checked against the identity its API key was bound to. Forging one requires
// already holding a key issued to that org, so the actor is a trusted insider
// and the impact is dashboard attribution; enforcing a match would break the
// git-email change this epic exists to support.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-tenant-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('hub privilege and tenant boundaries (CGLAB-75)', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;
  let viewerCookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
    viewerCookie = (await supertest(app).post('/auth/login').send({ email: 'view@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // ── Boundary 1: a viewer is read-only ────────────────────────────────────

  describe('device approval is an admin action', () => {
    const startDevice = () =>
      supertest(app).post('/hub/device/start').send({
        installation: { installationId: 'inst-new', osUser: 'dev', gitName: 'Dev', gitEmail: 'dev@cglab.com' },
      });

    it('refuses to let a viewer approve a device code', async () => {
      // /hub/device/start needs no auth at all, so a viewer who can also approve
      // holds the whole chain: start -> approve -> redeem -> live bearer token.
      // That is read-only escalating to ingest-and-fleet-write with no admin.
      const started = await startDevice();
      expect(started.status).toBe(200);

      const approved = await supertest(app).post('/hub/device/approve')
        .set('Cookie', viewerCookie).send({ userCode: started.body.userCode });

      expect(approved.status).toBe(403);
    });

    it('issues no api key when a viewer tries', async () => {
      const started = await startDevice();
      await supertest(app).post('/hub/device/approve')
        .set('Cookie', viewerCookie).send({ userCode: started.body.userCode });

      const keys = await ctx.db.all('SELECT token_hash FROM api_keys WHERE org_id = ?', ['org-a']);
      expect(keys).toEqual([]);
    });

    it('leaves the code unapproved, so it cannot be redeemed afterwards', async () => {
      const started = await startDevice();
      await supertest(app).post('/hub/device/approve')
        .set('Cookie', viewerCookie).send({ userCode: started.body.userCode });

      const row = await ctx.db.get(
        'SELECT approved_at FROM device_codes WHERE user_code = ?', [started.body.userCode],
      );
      expect((row as any).approved_at).toBeFalsy();
    });

    it('still lets an admin approve, which is the supported path', async () => {
      const started = await startDevice();
      const approved = await supertest(app).post('/hub/device/approve')
        .set('Cookie', adminCookie).send({ userCode: started.body.userCode });

      expect(approved.status).toBe(200);
      const keys = await ctx.db.all('SELECT token_hash FROM api_keys WHERE org_id = ?', ['org-a']);
      expect(keys).toHaveLength(1);
    });
  });

  // ── Boundary 2: an org-wide key stops at its own tenant ──────────────────

  describe('an org-wide key cannot reach another tenant', () => {
    let orgAKey: string;

    /** A victim installation and one live upgrade directive targeting it, in org-b. */
    const seedVictim = async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES ('victim-inst', 'org-b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'victim', 'Victim', 'victim@otherco.com')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type)
         VALUES ('victim-directive', 'org-b', '9.9.9', 'all')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
         VALUES ('victim-directive', 'victim-inst', 'pending')`,
      );
    };

    const postAs = (token: string, event: any) =>
      supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [event] });

    const baseEvent = (over: any = {}) => ({
      eventId: 'e-' + Math.random().toString(36).slice(2),
      installationId: 'victim-inst',
      orgId: 'org-a',
      occurredAt: '2026-08-21T10:00:00Z',
      actor: { osUser: 'attacker', gitName: 'Attacker', gitEmail: 'attacker@cglab.com' },
      type: 'item.created',
      payload: {},
      ...over,
    });

    beforeEach(async () => {
      // Admin-issued keys are UNBOUND by default, which is what removes the
      // per-event installation check.
      orgAKey = await issueApiKey(ctx.db, 'org-a', 'org-wide');
      await seedVictim();
    });

    it('does not overwrite the other org\'s installation identity', async () => {
      // installations.id is a global PK, so ON CONFLICT(id) DO UPDATE fires
      // against the victim's row even though the INSERT named org-a.
      await postAs(orgAKey, baseEvent());

      const row = await ctx.db.get(
        'SELECT org_id, os_user, git_email FROM installations WHERE id = ?', ['victim-inst'],
      );
      expect((row as any).org_id).toBe('org-b');
      expect((row as any).os_user).toBe('victim');
      expect((row as any).git_email).toBe('victim@otherco.com');
    });

    it('does not store the event against the foreign installation', async () => {
      const r = await postAs(orgAKey, baseEvent({ eventId: 'cross-1' }));
      expect(r.status).toBe(200);
      expect(r.body.ingested).toBe(0);

      const stored = await ctx.db.get('SELECT event_id FROM events WHERE event_id = ?', ['cross-1']);
      expect(stored).toBeFalsy();
    });

    it('does not forge the other org\'s fleet-upgrade outcome', async () => {
      // directiveId comes straight from the payload and the UPDATE had no org
      // predicate, so a foreign directive could be flipped to succeeded —
      // masking a broken rollout from the victim org's admin.
      await postAs(orgAKey, baseEvent({
        type: 'fleet:upgrade:succeeded',
        payload: { directiveId: 'victim-directive', version: '9.9.9' },
      }));

      const row = await ctx.db.get(
        'SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        ['victim-directive', 'victim-inst'],
      );
      expect((row as any).state).toBe('pending');
    });
  });

  // ── Boundary 2b: within one org, an unattributable key cannot speak for a machine ──

  describe('an unattributable org-wide key cannot transition a fleet upgrade', () => {
    it('leaves another installation\'s upgrade target alone', async () => {
      // The adjacent hub:repoint:* handler already refuses this, with a comment
      // that one holder could otherwise post 'succeeded' for the whole fleet.
      // The fleet:upgrade:* handler kept the exemption.
      const orgWide = await issueApiKey(ctx.db, 'org-a', 'org-wide');
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user)
         VALUES ('other-inst', 'org-a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'someone')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type)
         VALUES ('d1', 'org-a', '2.0.0', 'all')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
         VALUES ('d1', 'other-inst', 'pending')`,
      );

      await supertest(app).post('/v1/events').set('Authorization', `Bearer ${orgWide}`).send({
        events: [{
          eventId: 'forge-1', installationId: 'other-inst', orgId: 'org-a',
          occurredAt: '2026-08-21T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: 'dev@cglab.com' },
          type: 'fleet:upgrade:succeeded', payload: { directiveId: 'd1', version: '2.0.0' },
        }],
      });

      const row = await ctx.db.get(
        'SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        ['d1', 'other-inst'],
      );
      expect((row as any).state).toBe('pending');
    });

    it('still lets a bound key report its OWN upgrade outcome', async () => {
      // The fix must not break the legitimate path it exists to protect.
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user)
         VALUES ('mine', 'org-a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type)
         VALUES ('d2', 'org-a', '2.0.0', 'all')`,
      );
      await ctx.db.run(
        `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
         VALUES ('d2', 'mine', 'pending')`,
      );
      const bound = await issueApiKey(ctx.db, 'org-a', 'bound', { installationId: 'mine' });

      await supertest(app).post('/v1/events').set('Authorization', `Bearer ${bound}`).send({
        events: [{
          eventId: 'own-1', installationId: 'mine', orgId: 'org-a',
          occurredAt: '2026-08-21T10:00:00Z',
          actor: { osUser: 'dev', gitName: null, gitEmail: 'dev@cglab.com' },
          type: 'fleet:upgrade:succeeded', payload: { directiveId: 'd2', version: '2.0.0' },
        }],
      });

      const row = await ctx.db.get(
        'SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        ['d2', 'mine'],
      );
      expect((row as any).state).toBe('succeeded');
    });
  });
});
