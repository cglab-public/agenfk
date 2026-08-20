// Repoint campaign — hub side (CGLAB-66).
//
//   POST /v1/admin/repoint            — open a campaign onto a new hub URL
//   GET  /v1/admin/repoint            — drain board
//   POST /v1/admin/repoint/:id/close  — close it
//   GET  /v1/repoint-directive        — what the calling installation must do
//   POST /v1/events                   — hub:repoint:* transitions the target
//
// Clients store only {url, token, orgId} and api keys are org-scoped rather
// than host-scoped, so a hub can move DNS name without anyone rejoining. What
// was missing is push-down: /v1/ping tells a client nothing about the hub
// having moved. A campaign is that push-down, and the drain board is what makes
// it safe to drop the old name.
//
// The load-bearing rule: a target only reaches `succeeded` when its confirming
// event arrives on the NEW hostname. A client that reports success to the old
// endpoint has proved nothing about whether it actually moved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-repoint-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const NEW_URL = 'https://hub.new.example';
const NEW_HOST = 'hub.new.example';

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

describe('repoint campaign (hub side)', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;
  let token1: string;
  let token2: string;

  const seedInstallation = (id: string, gitEmail: string | null) =>
    ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, 'org-a', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', 'dev', null, ?)`,
      [id, gitEmail],
    );

  const openCampaign = (targetUrl = NEW_URL, cookie = cookieAdmin) =>
    supertest(app).post('/v1/admin/repoint').set('Cookie', cookie).send({ targetUrl });

  const board = (cookie = cookieAdmin) =>
    supertest(app).get('/v1/admin/repoint').set('Cookie', cookie);

  const directiveFor = (token: string) =>
    supertest(app).get('/v1/repoint-directive').set('Authorization', `Bearer ${token}`);

  /** Report an outcome as the client would, from a chosen hostname. */
  const report = (token: string, installationId: string, type: string, payload: any, host?: string) => {
    const req = supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Installation-Id', installationId);
    if (host) req.set('X-Forwarded-Host', host);
    return req.send({
      events: [{
        eventId: `ev-${Math.random().toString(36).slice(2)}`,
        installationId,
        orgId: 'org-a',
        occurredAt: new Date().toISOString(),
        actor: { osUser: 'dev', gitName: null, gitEmail: 'dev@acme.com' },
        type,
        payload,
      }],
    });
  };

  const targetState = (campaignId: string, installationId: string) =>
    ctx.db.get(
      'SELECT state, reported_url, error_message FROM repoint_campaign_targets WHERE campaign_id = ? AND installation_id = ?',
      [campaignId, installationId],
    );

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
    await seedInstallation('inst-1', 'a@acme.com');
    await seedInstallation('inst-2', 'b@acme.com');
    token1 = await issueApiKey(ctx.db, 'org-a', 'k1', { installationId: 'inst-1' } as any);
    token2 = await issueApiKey(ctx.db, 'org-a', 'k2', { installationId: 'inst-2' } as any);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated admin calls', async () => {
      expect((await supertest(app).post('/v1/admin/repoint').send({ targetUrl: NEW_URL })).status).toBe(401);
      expect((await supertest(app).get('/v1/admin/repoint')).status).toBe(401);
    });

    it('rejects a viewer opening a campaign', async () => {
      expect((await openCampaign(NEW_URL, cookieView)).status).toBe(403);
    });

    it('rejects an unauthenticated directive poll', async () => {
      expect((await supertest(app).get('/v1/repoint-directive')).status).toBe(401);
    });
  });

  describe('opening a campaign', () => {
    it('targets every live installation', async () => {
      const r = await openCampaign();

      expect(r.status).toBe(201);
      expect(r.body.targetUrl).toBe(NEW_URL);
      expect(r.body.targeted).toBe(2);
    });

    it('rejects a non-https target', async () => {
      // A plaintext hub URL would ship org telemetry and a bearer token in clear.
      const r = await openCampaign('http://hub.new.example');
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/https/i);
    });

    it.each([
      'https://127.0.0.1',
      'https://localhost',
      'https://10.0.0.5',
      'https://169.254.169.254',
      'https://hub.internal',
    ])('rejects the private target %s', async (url) => {
      // Every installation in the org would fetch this with its live bearer
      // token, turning a campaign into a token-harvest.
      const r = await openCampaign(url);
      expect(r.status).toBe(400);
    });

    it('rejects a target carrying userinfo', async () => {
      expect((await openCampaign('https://evil@hub.new.example')).status).toBe(400);
    });

    it('rejects a malformed target', async () => {
      expect((await openCampaign('not-a-url')).status).toBe(400);
    });

    it('excludes retired installations from the campaign', async () => {
      await supertest(app).post('/v1/admin/installations/inst-2/retire').set('Cookie', cookieAdmin);

      const r = await openCampaign();

      // Retired machines are never coming back; counting them would mean the
      // board never drains and the old DNS name can never be dropped.
      expect(r.body.targeted).toBe(1);
    });

    it('refuses a second campaign while one is open', async () => {
      await openCampaign();
      const r = await openCampaign('https://hub.other.example');
      expect(r.status).toBe(409);
    });

    it('allows a new campaign once the previous one is closed', async () => {
      const first = await openCampaign();
      await supertest(app).post(`/v1/admin/repoint/${first.body.id}/close`).set('Cookie', cookieAdmin);

      expect((await openCampaign('https://hub.other.example')).status).toBe(201);
    });
  });

  describe('GET /v1/repoint-directive', () => {
    it('hands the target url to a pending installation', async () => {
      const c = await openCampaign();

      const r = await directiveFor(token1);

      expect(r.status).toBe(200);
      expect(r.body.campaignId).toBe(c.body.id);
      expect(r.body.targetUrl).toBe(NEW_URL);
      expect(r.body.allowedHost).toBe(NEW_HOST);
    });

    it('204s when no campaign is open', async () => {
      expect((await directiveFor(token1)).status).toBe(204);
    });

    it('204s once the installation has already reported success', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      expect((await directiveFor(token1)).status).toBe(204);
    });

    it('204s for a legacy org-wide key with no installation binding', async () => {
      const orgToken = await issueApiKey(ctx.db, 'org-a', 'legacy');
      await openCampaign();

      expect((await directiveFor(orgToken)).status).toBe(204);
    });

    it('204s for a hidden person, who could never complete one', async () => {
      // Their events are dropped at ingest before the transition runs, so
      // handing them a directive would have them rewriting hub.json and
      // reporting into the void forever while the board showed plain pending.
      //
      // Hiding also revokes their keys, so the poll normally 401s before
      // reaching this filter; the key is re-issued here to exercise the filter
      // itself, which is the backstop for a key issued after the hide.
      await supertest(app).post('/v1/admin/hidden-users')
        .set('Cookie', cookieAdmin).send({ userKey: 'a@acme.com' });
      await openCampaign();
      const fresh = await issueApiKey(ctx.db, 'org-a', 'post-hide', { installationId: 'inst-1' } as any);

      expect((await directiveFor(fresh)).status).toBe(204);
      // The unhidden peer still gets one, proving the filter is not blanket.
      expect((await directiveFor(token2)).status).toBe(200);
    });

    it('204s after the campaign is closed', async () => {
      const c = await openCampaign();
      await supertest(app).post(`/v1/admin/repoint/${c.body.id}/close`).set('Cookie', cookieAdmin);

      expect((await directiveFor(token1)).status).toBe(204);
    });
  });

  describe('completion is verified against the request host', () => {
    it('marks succeeded when the report arrives on the new hostname', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      const t = await targetState(c.body.id, 'inst-1');
      expect(t.state).toBe('succeeded');
      expect(t.reported_url).toBe(NEW_URL);
    });

    it('does NOT mark succeeded when the report arrives on the old hostname', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, 'hub.old.example');

      // The client claims it moved but is still talking to us on the old name,
      // so nothing has been proved.
      const t = await targetState(c.body.id, 'inst-1');
      expect(t.state).toBe('pending');
      expect(String(t.error_message)).toMatch(/host/i);
    });

    it('accepts blocked_by_env from the old hostname, since it is a report of not moving', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:blocked', { campaignId: c.body.id, reason: 'AGENFK_HUB_URL is set' }, 'hub.old.example');

      const t = await targetState(c.body.id, 'inst-1');
      expect(t.state).toBe('blocked_by_env');
      expect(String(t.error_message)).toMatch(/AGENFK_HUB_URL/);
    });

    it('accepts a failure report from the old hostname', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:failed', { campaignId: c.body.id, error: 'healthz did not identify as agenfk-hub' }, 'hub.old.example');

      const t = await targetState(c.body.id, 'inst-1');
      expect(t.state).toBe('failed');
      expect(String(t.error_message)).toMatch(/healthz/);
    });

    it('ignores a report naming an unknown campaign', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: 'no-such', url: NEW_URL }, NEW_HOST);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('pending');
    });

    it('does not let one installation report for another', async () => {
      const c = await openCampaign();

      // inst-1's key claiming inst-2 moved — the existing BOLA guard rejects it.
      await report(token1, 'inst-2', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      expect((await targetState(c.body.id, 'inst-2')).state).toBe('pending');
    });

    it('a later failure does not overwrite a proved success', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      await report(token1, 'inst-1', 'hub:repoint:failed', { campaignId: c.body.id, error: 'late noise' }, NEW_HOST);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('succeeded');
    });

    it('a blocked installation can still succeed later once the env var is gone', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:blocked', { campaignId: c.body.id, reason: 'env' }, 'hub.old.example');

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('succeeded');
    });
  });

  describe('completion cannot be forged', () => {
    it('refuses a repoint report from a legacy org-wide key', async () => {
      // Such a key is bound to no installation, so one holder could otherwise
      // post 'succeeded' for every install in the org, the board would read
      // drained, and the admin would drop a DNS record the fleet still needs.
      const orgToken = await issueApiKey(ctx.db, 'org-a', 'legacy');
      const c = await openCampaign();

      await report(orgToken, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);
      await report(orgToken, 'inst-2', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('pending');
      expect((await targetState(c.body.id, 'inst-2')).state).toBe('pending');
      expect((await board()).body.drained).toBe(false);
    });

    it('ignores a client-appended X-Forwarded-Host hop', async () => {
      // Nothing strips this header, so its leftmost element is attacker-chosen.
      // A proxy appends, meaning the trustworthy hop is the LAST one.
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL },
        `${NEW_HOST}, hub.old.example`);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('pending');
    });

    it('accepts the real host when a proxy appended it last', async () => {
      const c = await openCampaign();

      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL },
        `hub.internal, ${NEW_HOST}`);

      expect((await targetState(c.body.id, 'inst-1')).state).toBe('succeeded');
    });
  });

  describe('campaign selection is consistent', () => {
    it('serves the same campaign the board reports', async () => {
      // A board watching one campaign while clients confirm another shows 100%
      // pending forever with no way to reach the other one.
      const c = await openCampaign();
      const d = await directiveFor(token1);
      const b = await board();

      expect(d.body.campaignId).toBe(b.body.campaign.id);
      expect(d.body.campaignId).toBe(c.body.id);
    });
  });

  describe('drain board', () => {
    it('reports per-state counts and rows', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      const r = await board();

      expect(r.status).toBe(200);
      expect(r.body.campaign.id).toBe(c.body.id);
      expect(r.body.counts).toMatchObject({ succeeded: 1, pending: 1 });
      expect(r.body.targets).toHaveLength(2);
      const row = r.body.targets.find((t: any) => t.installationId === 'inst-1');
      expect(row.state).toBe('succeeded');
      // Identity comes from the installations row, which ingest legitimately
      // refreshes from the reporting actor — so this is the actor's email, not
      // the one seeded before the report.
      expect(row.gitEmail).toBe('dev@acme.com');
    });

    it('reports no open campaign when there is none', async () => {
      const r = await board();
      expect(r.status).toBe(200);
      expect(r.body.campaign).toBeNull();
    });

    it('says when the fleet has fully drained, so the old name can be dropped', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);
      await report(token2, 'inst-2', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      const r = await board();

      expect(r.body.drained).toBe(true);
      expect(r.body.counts.pending).toBe(0);
    });

    it('is not drained while anything is still pending or blocked', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:blocked', { campaignId: c.body.id, reason: 'env' }, 'hub.old.example');
      await report(token2, 'inst-2', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);

      expect((await board()).body.drained).toBe(false);
    });

    it('counts as drained once every remaining installation is retired', async () => {
      // The documented escape hatch must not invert when it is used on all of
      // them: nothing is left resolving the old name, so it is safe to drop.
      const c = await openCampaign();
      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);
      await supertest(app).post('/v1/admin/installations/inst-2/retire').set('Cookie', cookieAdmin);

      const r = await board();

      expect(r.body.targets).toHaveLength(0);
      expect(r.body.drained).toBe(true);
    });

    it('retiring a stale installation drains the campaign', async () => {
      const c = await openCampaign();
      await report(token1, 'inst-1', 'hub:repoint:succeeded', { campaignId: c.body.id, url: NEW_URL }, NEW_HOST);
      expect((await board()).body.drained).toBe(false);

      // inst-2 is a wiped laptop that will never poll again — retiring it is
      // the documented way to finish a campaign.
      await supertest(app).post('/v1/admin/installations/inst-2/retire').set('Cookie', cookieAdmin);

      expect((await board()).body.drained).toBe(true);
    });
  });

  describe('closing a campaign', () => {
    it('closes it and stops handing out directives', async () => {
      const c = await openCampaign();

      const r = await supertest(app).post(`/v1/admin/repoint/${c.body.id}/close`).set('Cookie', cookieAdmin);

      expect(r.status).toBe(200);
      expect((await board()).body.campaign).toBeNull();
    });

    it('404s an unknown campaign', async () => {
      expect((await supertest(app).post('/v1/admin/repoint/nope/close').set('Cookie', cookieAdmin)).status).toBe(404);
    });

    it('rejects a viewer closing it', async () => {
      const c = await openCampaign();
      expect((await supertest(app).post(`/v1/admin/repoint/${c.body.id}/close`).set('Cookie', cookieView)).status).toBe(403);
    });
  });
});
