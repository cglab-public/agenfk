// Story CGLAB-181, task 1 — parent side of hub federation.
//
// A child hub enrolls with the parent by redeeming an admin-issued HMAC invite
// of kind 'child-hub'. It receives a federation key: a principal that is
// distinct from the installation api_key. The two credential kinds must never
// be interchangeable — a child hub cannot post installation events, and an
// installation cannot heartbeat as a child hub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { signInviteToken } from '../auth/inviteToken';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-federation-enroll-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('hub federation: child-hub enrollment (parent side)', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;
  let viewerCookie: string;

  async function createInvite(): Promise<string> {
    const r = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    expect(r.status).toBe(200);
    return r.body.inviteToken as string;
  }

  async function enroll(name = 'acme-child', extra: Record<string, unknown> = {}) {
    const inviteToken = await createInvite();
    const r = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken, childHub: { name, hubVersion: '1.1.19' }, ...extra,
    });
    return r;
  }

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
    const a = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    adminCookie = a.headers['set-cookie']?.[0] ?? '';
    const v = await supertest(app).post('/auth/login').send({ email: 'viewer@x', password: 'longenough1' });
    viewerCookie = v.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  describe('schema', () => {
    it('creates the child_hubs and federation_keys tables on boot', async () => {
      const tables = await ctx.db.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('child_hubs','federation_keys') ORDER BY name",
      );
      expect(tables.map((t: any) => t.name)).toEqual(['child_hubs', 'federation_keys']);
    });
  });

  describe('POST /hub/federation/invite/create', () => {
    it('requires an admin session', async () => {
      const anon = await supertest(app).post('/hub/federation/invite/create').send({});
      expect(anon.status).toBe(401);
      const viewer = await supertest(app).post('/hub/federation/invite/create').set('Cookie', viewerCookie).send({});
      expect(viewer.status).toBe(403);
    });

    it('returns a signed invite with the parent url and a 14-day expiry', async () => {
      const r = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
      expect(r.status).toBe(200);
      expect(typeof r.body.inviteToken).toBe('string');
      expect(r.body.inviteToken).toContain('.');
      expect(typeof r.body.parentUrl).toBe('string');
      const ttlMs = new Date(r.body.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(13 * 86400_000);
      expect(ttlMs).toBeLessThanOrEqual(14 * 86400_000);
    });
  });

  describe('POST /v1/federation/enroll', () => {
    it('redeems the invite: creates a child_hubs row and returns a fed_ token once', async () => {
      const r = await enroll('acme-child');
      expect(r.status).toBe(200);
      expect(r.body.token).toMatch(/^fed_[0-9a-f]{64}$/);
      expect(typeof r.body.childHubId).toBe('string');
      expect(r.body.orgId).toBe('org');
      expect(typeof r.body.parentUrl).toBe('string');

      const row = await ctx.db.get('SELECT * FROM child_hubs WHERE id = ?', [r.body.childHubId]);
      expect(row.org_id).toBe('org');
      expect(row.name).toBe('acme-child');
      expect(row.hub_version).toBe('1.1.19');
      expect(row.first_seen).toBeTruthy();
      expect(row.last_seen).toBeTruthy();
      expect(row.detached_at).toBeNull();

      // The raw token is never stored — only its hash.
      const keys = await ctx.db.all('SELECT * FROM federation_keys WHERE child_hub_id = ?', [r.body.childHubId]);
      expect(keys).toHaveLength(1);
      expect(keys[0].token_hash).not.toContain(r.body.token);
      expect(keys[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(keys[0].org_id).toBe('org');
      expect(keys[0].revoked_at).toBeNull();
    });

    it('is single-use: the same invite cannot enroll twice', async () => {
      const inviteToken = await createInvite();
      const first = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'a' } });
      expect(first.status).toBe(200);
      const second = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'b' } });
      expect(second.status).toBe(400);
      expect(second.body.error).toMatch(/already used/i);
    });

    it('rejects a missing or malformed invite', async () => {
      expect((await supertest(app).post('/v1/federation/enroll').send({})).status).toBe(400);
      expect((await supertest(app).post('/v1/federation/enroll').send({ inviteToken: 'nope' })).status).toBe(400);
    });

    it('rejects a forged signature on an invite that was never redeemed', async () => {
      // The signature must be what refuses this token. An earlier version of
      // this test forged a token whose body was already burned, so it passed
      // even with the HMAC check removed.
      const inviteToken = await createInvite();
      const [body, sig] = inviteToken.split('.');
      const forged = `${body}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: forged, childHub: { name: 'x' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/invalid/i);
      expect(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM child_hubs')).n)).toBe(0);
      // the nonce was NOT burned, so the genuine invite still works
      const ok = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'x' } });
      expect(ok.status).toBe(200);
    });

    it('refuses an over-long invite token before hashing it', async () => {
      const r = await supertest(app).post('/v1/federation/enroll')
        .send({ inviteToken: 'x'.repeat(5000), childHub: { name: 'x' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/invalid/i);
    });

    it('accepts a legacy kind-less installation invite only on the installation route', async () => {
      // Tokens minted before federation existed carry no `kind`.
      const legacy = signInviteToken(
        { orgId: 'org', nonce: 'legacy-nonce-1', exp: Date.now() + 60_000 }, SECRET,
      );
      const fed = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: legacy, childHub: { name: 'x' } });
      expect(fed.status).toBe(400);
      const inst = await supertest(app).post('/hub/invite/redeem').send({ inviteToken: legacy });
      expect(inst.status).toBe(200);
      expect(inst.body.token).toMatch(/^agk_/);
    });

    it('rejects an INSTALLATION invite — the two invite kinds are not interchangeable', async () => {
      const inst = await supertest(app).post('/hub/invite/create').set('Cookie', adminCookie).send({});
      expect(inst.status).toBe(200);
      const r = await supertest(app).post('/v1/federation/enroll').send({
        inviteToken: inst.body.inviteToken, childHub: { name: 'sneaky' },
      });
      expect(r.status).toBe(400);
      const count = await ctx.db.get('SELECT COUNT(*) AS n FROM child_hubs');
      expect(Number(count.n)).toBe(0);
    });

    it('a child-hub invite cannot be redeemed as an installation invite either', async () => {
      const inviteToken = await createInvite();
      const r = await supertest(app).post('/hub/invite/redeem').send({ inviteToken });
      expect(r.status).toBe(400);
      const keys = await ctx.db.get('SELECT COUNT(*) AS n FROM api_keys');
      expect(Number(keys.n)).toBe(0);
    });

    it('requires a non-empty child hub name and trims it', async () => {
      const noName = await enroll('   ');
      expect(noName.status).toBe(400);
      expect(noName.body.error).toMatch(/required/i);
      const tooLong = await enroll('x'.repeat(121));
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toMatch(/exceeds/i);
      const padded = await enroll('  padded  ');
      expect(padded.status).toBe(200);
      const row = await ctx.db.get('SELECT name FROM child_hubs WHERE id = ?', [padded.body.childHubId]);
      expect(row.name).toBe('padded');
    });
  });

  describe('enrollment is atomic', () => {
    it('rolls the invite back when a later write fails, instead of hanging or spending it', async () => {
      const inviteToken = await createInvite();
      const realRun = ctx.db.run.bind(ctx.db);
      let broken = true;
      ctx.db.run = async (sql: string, params?: unknown[]) => {
        if (broken && /INSERT INTO child_hubs/i.test(sql)) throw new Error('disk I/O error');
        return realRun(sql, params);
      };
      const boom = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'doomed' } });
      ctx.db.run = realRun;
      // A rejected promise in express 4 is not forwarded on its own — the child
      // would wait for a timeout rather than see this.
      expect(boom.status).toBe(500);
      expect(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM child_hubs')).n)).toBe(0);
      expect(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM federation_keys')).n)).toBe(0);
      // the invite survived the failure and still enrolls
      const retry = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'recovered' } });
      expect(retry.status).toBe(200);
    });

    it('burns the invite before minting the key, so a burn failure hands out nothing', async () => {
      // Ordering matters under concurrency: minting first means a losing
      // racer has already been given a credential by the time the nonce
      // insert fails. Forcing the burn to fail is the deterministic way to
      // observe which side of the mint it runs on.
      const inviteToken = await createInvite();
      const realRun = ctx.db.run.bind(ctx.db);
      ctx.db.run = async (sql: string, params?: unknown[]) => {
        if (/INSERT INTO used_invites/i.test(sql)) throw new Error('disk I/O error');
        return realRun(sql, params);
      };
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken, childHub: { name: 'x' } });
      ctx.db.run = realRun;
      expect(r.status).toBe(500);
      expect(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM federation_keys')).n)).toBe(0);
      expect(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM child_hubs')).n)).toBe(0);
    });

    it('rate-limits the unauthenticated enroll endpoint on its own, not by accident', async () => {
      let sawLimit = false;
      for (let i = 0; i < 70 && !sawLimit; i++) {
        const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: 'bad' });
        if (r.status === 429) sawLimit = true;
      }
      expect(sawLimit).toBe(true);
    });
  });

  describe('federation principal', () => {
    it('POST /v1/federation/ping accepts a federation key and refreshes last_seen + hub_version', async () => {
      const e = await enroll();
      await ctx.db.run("UPDATE child_hubs SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = ?", [e.body.childHubId]);
      const r = await supertest(app).post('/v1/federation/ping')
        .set('Authorization', `Bearer ${e.body.token}`)
        .send({ hubVersion: '1.2.0' });
      expect(r.status).toBe(200);
      // identityPolicy rides on the heartbeat (CGLAB-184) — 'keep' unless an
      // admin has opted out group-wide or for this child.
      expect(r.body).toEqual({ ok: true, childHubId: e.body.childHubId, orgId: 'org', identityPolicy: 'keep' });
      const row = await ctx.db.get('SELECT last_seen, hub_version FROM child_hubs WHERE id = ?', [e.body.childHubId]);
      expect(new Date(row.last_seen).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(row.hub_version).toBe('1.2.0');
    });

    it('ping ignores a malformed hubVersion instead of storing it', async () => {
      const e = await enroll();
      const r = await supertest(app).post('/v1/federation/ping')
        .set('Authorization', `Bearer ${e.body.token}`)
        .send({ hubVersion: '<script>alert(1)</script>' });
      expect(r.status).toBe(200);
      const row = await ctx.db.get('SELECT hub_version FROM child_hubs WHERE id = ?', [e.body.childHubId]);
      expect(row.hub_version).toBe('1.1.19');
    });

    it('tells the child the identity policy, group default overridden per child', async () => {
      const a = await enroll('alpha');
      const b = await enroll('beta');
      const ping = (token: string) => supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${token}`).send({});

      // default: real identities, because a group is usually one organisation
      expect((await ping(a.body.token)).body.identityPolicy).toBe('keep');

      // group-wide opt-out reaches every child
      await ctx.db.run("INSERT INTO org_settings (org_id, identity_policy) VALUES ('org','pseudonymize') ON CONFLICT(org_id) DO UPDATE SET identity_policy = 'pseudonymize'");
      expect((await ping(a.body.token)).body.identityPolicy).toBe('pseudonymize');
      expect((await ping(b.body.token)).body.identityPolicy).toBe('pseudonymize');

      // a per-child setting overrides it, in both directions
      await ctx.db.run("UPDATE child_hubs SET identity_policy = 'keep' WHERE id = ?", [a.body.childHubId]);
      expect((await ping(a.body.token)).body.identityPolicy).toBe('keep');
      expect((await ping(b.body.token)).body.identityPolicy).toBe('pseudonymize');

      await ctx.db.run("UPDATE org_settings SET identity_policy = 'keep' WHERE org_id = 'org'");
      await ctx.db.run("UPDATE child_hubs SET identity_policy = 'pseudonymize' WHERE id = ?", [b.body.childHubId]);
      expect((await ping(a.body.token)).body.identityPolicy).toBe('keep');
      expect((await ping(b.body.token)).body.identityPolicy).toBe('pseudonymize');
    });

    it('GET /v1/federation/directives answers 204 for an enrolled child hub (no directive kinds yet)', async () => {
      const e = await enroll();
      const r = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${e.body.token}`);
      expect(r.status).toBe(204);
    });

    it('rejects a missing or unknown bearer', async () => {
      expect((await supertest(app).post('/v1/federation/ping').send({})).status).toBe(401);
      expect((await supertest(app).post('/v1/federation/ping').set('Authorization', 'Bearer fed_' + 'f'.repeat(64)).send({})).status).toBe(401);
      expect((await supertest(app).get('/v1/federation/directives')).status).toBe(401);
    });

    it('an INSTALLATION api_key is not a federation principal', async () => {
      const instToken = await issueApiKey(ctx.db, 'org', 'inst');
      const ping = await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${instToken}`).send({});
      expect(ping.status).toBe(401);
      const dir = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${instToken}`);
      expect(dir.status).toBe(401);
    });

    it('a federation key is not an installation principal', async () => {
      const e = await enroll();
      const ping = await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${e.body.token}`);
      expect(ping.status).toBe(401);
      const events = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${e.body.token}`).send({ events: [] });
      expect(events.status).toBe(401);
      const upgrade = await supertest(app).get('/v1/upgrade-directive').set('Authorization', `Bearer ${e.body.token}`);
      expect(upgrade.status).toBe(401);
    });

    it('a revoked federation key is refused', async () => {
      const e = await enroll();
      await ctx.db.run("UPDATE federation_keys SET revoked_at = datetime('now') WHERE child_hub_id = ?", [e.body.childHubId]);
      const r = await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${e.body.token}`).send({});
      expect(r.status).toBe(401);
    });

    it('a detached child hub is refused even if its key row was not revoked', async () => {
      const e = await enroll();
      await ctx.db.run("UPDATE child_hubs SET detached_at = datetime('now') WHERE id = ?", [e.body.childHubId]);
      const ping = await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${e.body.token}`).send({});
      expect(ping.status).toBe(401);
      const dir = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${e.body.token}`);
      expect(dir.status).toBe(401);
      // and the refusal must not have refreshed last_seen
      const row = await ctx.db.get('SELECT last_seen, first_seen FROM child_hubs WHERE id = ?', [e.body.childHubId]);
      expect(row.last_seen).toBe(row.first_seen);
    });
  });
});
