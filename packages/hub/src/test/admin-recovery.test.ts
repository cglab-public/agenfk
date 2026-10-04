/**
 * STORY a44f3697 — getting an admin back into an SSO-only hub whose SSO broke.
 *
 * Every admin invited by SSO has no password (password_hash NULL). If password
 * sign-in is switched off and the provider then breaks, nothing let an admin
 * back in: AGENFK_HUB_FORCE_PASSWORD_LOGIN needs a password hash, and the
 * bootstrap token works only while the hub has no users.
 *
 * The operator's way back (user's decision, 2026-10-04): restart the hub with
 * AGENFK_HUB_RESET_ADMIN_EMAIL naming an admin. Boot mints a single-use,
 * short-lived recovery token for that admin and logs it, like the bootstrap
 * token; redeeming it sets the admin's password and signs them in, whatever
 * the sign-in settings say. Access to the host's env and logs is the trust
 * boundary - nothing in the app can switch this on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { createHubApp, configFromEnv } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-recovery-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };
const BASE = { dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' };

let server: any = null;
let ctx: any = null;
let logged: string[] = [];

/** Boot the hub (again) on the same database, capturing what it logs. */
async function boot(extra: Record<string, unknown> = {}) {
  if (server) { await drainApp(server); server = null; }
  if (ctx) { await ctx.db.close(); ctx = null; }
  logged = [];
  const capture = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const warn = vi.spyOn(console, 'warn').mockImplementation(capture);
  const out = await createHubApp({ ...BASE, ...extra } as any);
  log.mockRestore(); warn.mockRestore();
  server = out.app.listen(0);
  ctx = out.ctx;
}
/** The recovery token the boot banner printed, if any. */
const printedToken = (): string | null => {
  const banner = logged.find(l => /admin recovery/i.test(l));
  return banner?.match(/([A-Za-z0-9_-]{40,})/)?.[1] ?? null;
};
async function ssoAdmin(email = 'sso-admin@x', role = 'admin', active = 1) {
  await ctx.db.run('INSERT INTO users (id, org_id, email, password_hash, provider, provider_subject, role, active) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
    [randomUUID(), 'org', email, 'google', `sub-${email}`, role, active]);
}
const switchPasswordOff = () => ctx.db.run('UPDATE auth_config SET password_enabled = 0 WHERE org_id = ?', ['org']);
const recover = (token: unknown, password: unknown = 'a-new-password-1') => supertest(server).post('/auth/recover').send({ token, password });

beforeEach(async () => { cleanup(); await boot(); });
afterEach(async () => {
  if (server) await drainApp(server);
  if (ctx) await ctx.db.close();
  server = null; ctx = null;
  cleanup();
});

describe('AGENFK_HUB_RESET_ADMIN_EMAIL', () => {
  it('mints a token at boot for an SSO-only admin, and redeeming it signs that admin in with password sign-in switched off', async () => {
    await ssoAdmin();
    await switchPasswordOff();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken();
    expect(token, logged.join('\n')).toBeTruthy();

    const r = await recover(token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ email: 'sso-admin@x', role: 'admin' });
    const cookie = r.headers['set-cookie']?.[0];
    expect(cookie).toBeTruthy();
    const me = await supertest(server).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'sso-admin@x', role: 'admin' });
  });

  it('is single-use', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken();
    expect((await recover(token)).status).toBe(200);
    const again = await recover(token);
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('expires', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken();
    await ctx.db.run('UPDATE admin_recovery_tokens SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    expect((await recover(token)).status).toBe(401);
  });

  it('refuses a wrong token, setting no cookie', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const r = await recover('x'.repeat(43));
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await recover(undefined)).status).toBe(401);
  });

  it('keeps only a hash of the token', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken()!;
    const rows = await ctx.db.all('SELECT * FROM admin_recovery_tokens', []);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('leaves a password the admin can sign in with once password sign-in is back on', async () => {
    await ssoAdmin();
    await switchPasswordOff();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    expect((await recover(printedToken(), 'chosen-password-9')).status).toBe(200);
    await ctx.db.run('UPDATE auth_config SET password_enabled = 1 WHERE org_id = ?', ['org']);
    const login = await supertest(server).post('/auth/login').send({ email: 'sso-admin@x', password: 'chosen-password-9' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });

  it('refuses a short password without spending the token', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken();
    expect((await recover(token, 'short')).status).toBe(400);
    expect((await recover(token)).status).toBe(200);
  });

  // BUG 91d2941d (review): this used to pin "a new boot replaces the earlier token". On a hub run as
  // several instances, or restarted mid-recovery, another boot then withdrew the token the operator was
  // reading off the log. A token now lives until it is used or expires; boots clear only expired ones.
  it("another boot does not withdraw a token already logged; an expired one is cleared", async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const first = printedToken();
    await ctx.db.run('INSERT INTO admin_recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', ['stale', 'nobody', new Date(Date.now() - 1000).toISOString()]);
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const second = printedToken();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await boot();
    expect(await ctx.db.all("SELECT * FROM admin_recovery_tokens WHERE token_hash = 'stale'", [])).toHaveLength(0);
    expect((await recover(first)).status).toBe(200);
    expect((await recover(second)).status).toBe(200);
  });

  for (const [what, setup] of [
    ['an unknown email', async () => {}],
    ['a viewer', async () => ssoAdmin('sso-admin@x', 'viewer')],
    ['a deactivated admin', async () => ssoAdmin('sso-admin@x', 'admin', 0)],
  ] as const) {
    it(`mints nothing for ${what}, and says so`, async () => {
      await setup();
      await boot({ resetAdminEmail: 'sso-admin@x' });
      expect(printedToken()).toBeNull();
      expect(logged.join('\n')).toMatch(/AGENFK_HUB_RESET_ADMIN_EMAIL/);
      expect(await ctx.db.all('SELECT * FROM admin_recovery_tokens', [])).toHaveLength(0);
    });
  }

  it('mints nothing when the variable is not set', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    await boot();
    expect(printedToken()).toBeNull();
    expect(await ctx.db.all('SELECT * FROM admin_recovery_tokens', [])).toHaveLength(0);
  });

  it('a token minted for an admin who was demoted since signs nobody in', async () => {
    await ssoAdmin();
    await boot({ resetAdminEmail: 'sso-admin@x' });
    const token = printedToken();
    await ctx.db.run("UPDATE users SET role = 'viewer' WHERE email = ?", ['sso-admin@x']);
    expect((await recover(token)).status).toBe(401);
  });
});

describe('configFromEnv', () => {
  it('reads AGENFK_HUB_RESET_ADMIN_EMAIL', () => {
    const saved = { ...process.env };
    try {
      process.env.AGENFK_HUB_SECRET_KEY = 'a'.repeat(64);
      process.env.AGENFK_HUB_SESSION_SECRET = 's';
      process.env.AGENFK_HUB_RESET_ADMIN_EMAIL = ' Admin@X ';
      expect(configFromEnv().resetAdminEmail).toBe('Admin@X');
      delete process.env.AGENFK_HUB_RESET_ADMIN_EMAIL;
      expect(configFromEnv().resetAdminEmail).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});
