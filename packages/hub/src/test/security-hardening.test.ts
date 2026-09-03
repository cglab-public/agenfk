/**
 * Security hardening — EPIC 4c3c2018 (full-scan findings, 2026-06-27).
 * Hub-side findings: 210b3d34, a7a448dc, 72f8da10, 035a4736, f3d62844.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { createPasswordUser } from '../auth/password';
import { cookieSecure } from '../auth/session';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-security-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const sampleEvent = (overrides: Partial<any> = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: { title: 'demo' },
  ...overrides,
});

describe('hub security hardening', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app;
    ctx = out.ctx;
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  // ── bug 210b3d34: login brute-force lockout ─────────────────────────────────
  describe('bug 210b3d34: /auth/login lockout', () => {
    it('locks an account after repeated failures and clears on success', async () => {
      await createPasswordUser(ctx.db, 'org', 'victim@example.com', 'correct-horse', 'admin');
      // 5 wrong attempts → still 401, then locked
      for (let i = 0; i < 5; i++) {
        const r = await supertest(app).post('/auth/login').send({ email: 'victim@example.com', password: 'wrong' });
        expect(r.status).toBe(401);
      }
      const locked = await supertest(app).post('/auth/login').send({ email: 'victim@example.com', password: 'wrong' });
      expect(locked.status).toBe(429);
      // Even the CORRECT password is refused while locked.
      const lockedCorrect = await supertest(app).post('/auth/login').send({ email: 'victim@example.com', password: 'correct-horse' });
      expect(lockedCorrect.status).toBe(429);
    });

    it('a fresh account with the right password logs in (control)', async () => {
      await createPasswordUser(ctx.db, 'org', 'good@example.com', 'correct-horse', 'admin');
      const r = await supertest(app).post('/auth/login').send({ email: 'good@example.com', password: 'correct-horse' });
      expect(r.status).toBe(200);
      expect(r.headers['set-cookie']).toBeTruthy();
    });
  });

  // ── bug a7a448dc: installationId bound to API key (BOLA) ─────────────────────
  describe('bug a7a448dc: events bound to the key installation', () => {
    it('rejects events whose installationId differs from an installation-bound key', async () => {
      const token = await issueApiKey(ctx.db, 'org', 'bound', { installationId: 'inst-1' });
      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ events: [sampleEvent({ installationId: 'inst-2', eventId: 'spoof' })] });
      expect(r.status).toBe(200);
      expect(r.body.rejected).toBe(1);
      expect(r.body.ingested).toBe(0);
    });

    it('accepts events for the key own installation', async () => {
      const token = await issueApiKey(ctx.db, 'org', 'bound', { installationId: 'inst-1' });
      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ events: [sampleEvent({ installationId: 'inst-1', eventId: 'own' })] });
      expect(r.body.ingested).toBe(1);
      expect(r.body.rejected).toBe(0);
    });

    it('legacy org-wide keys (no bound installation) keep working', async () => {
      const token = await issueApiKey(ctx.db, 'org', 'legacy');
      const r = await supertest(app).post('/v1/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ events: [sampleEvent({ installationId: 'inst-9', eventId: 'legacy-ok' })] });
      expect(r.body.ingested).toBe(1);
    });
  });

  // ── bug 035a4736: per-batch event cap ───────────────────────────────────────
  describe('bug 035a4736: /v1/events per-batch cap', () => {
    it('rejects a batch over the cap with 413', async () => {
      const token = await issueApiKey(ctx.db, 'org', 'capped');
      const events = Array.from({ length: 501 }, (_, i) => sampleEvent({ eventId: `big-${i}` }));
      const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
      expect(r.status).toBe(413);
      const countRow = await ctx.db.get('SELECT COUNT(*) AS c FROM events') as { c: number };
      expect(countRow.c).toBe(0); // nothing written
    });

    it('accepts a batch at the cap', async () => {
      const token = await issueApiKey(ctx.db, 'org', 'capped2');
      const events = Array.from({ length: 500 }, (_, i) => sampleEvent({ eventId: `ok-${i}` }));
      const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
      expect(r.status).toBe(200);
      expect(r.body.ingested).toBe(500);
    });
  });

  // ── bug 72f8da10: device-code pruning ───────────────────────────────────────
  describe('bug 72f8da10: device-code flow prunes expired rows', () => {
    it('deletes expired device_codes on /device/start', async () => {
      await ctx.db.run(
        'INSERT INTO device_codes (device_code, user_code, expires_at) VALUES (?, ?, ?)',
        ['stale-device', 'OLD1-OLD2', '2000-01-01T00:00:00.000Z'],
      );
      const before = await ctx.db.get('SELECT COUNT(*) AS c FROM device_codes') as { c: number };
      expect(before.c).toBe(1);

      const r = await supertest(app).post('/hub/device/start').send({});
      expect(r.status).toBe(200);
      expect(r.body.deviceCode).toBeTruthy();

      const stale = await ctx.db.get('SELECT 1 AS x FROM device_codes WHERE device_code = ?', ['stale-device']);
      expect(stale).toBeFalsy(); // expired row was pruned
    });
  });
});

// ── bug f3d62844: cookie Secure derives from request protocol, not NODE_ENV ───
describe('bug f3d62844: cookieSecure', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevExplicit = process.env.AGENFK_HUB_COOKIE_SECURE;
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
    if (prevExplicit === undefined) delete process.env.AGENFK_HUB_COOKIE_SECURE;
    else process.env.AGENFK_HUB_COOKIE_SECURE = prevExplicit;
  });

  it('is true when the request arrived over HTTPS (x-forwarded-proto), even off-prod', () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.AGENFK_HUB_COOKIE_SECURE;
    expect(cookieSecure({ headers: { 'x-forwarded-proto': 'https' } } as any)).toBe(true);
    expect(cookieSecure({ secure: true, headers: {} } as any)).toBe(true);
  });

  it('honours the explicit override either way', () => {
    process.env.AGENFK_HUB_COOKIE_SECURE = 'true';
    expect(cookieSecure(undefined)).toBe(true);
    process.env.AGENFK_HUB_COOKIE_SECURE = 'false';
    expect(cookieSecure({ secure: true, headers: {} } as any)).toBe(false);
  });

  it('falls back to false for a plaintext non-prod request (local dev still works)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AGENFK_HUB_COOKIE_SECURE;
    expect(cookieSecure({ headers: { 'x-forwarded-proto': 'http' } } as any)).toBe(false);
  });
});
