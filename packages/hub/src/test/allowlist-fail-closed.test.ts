/** The SSO email allowlist fails closed: NULL means no restriction, anything unreadable denies. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { checkEmailAllowlist } from '../auth/oauth';
import { encryptSecret } from '../crypto';
import { adminCanStillSignIn, signInLockoutReason } from '../routes/admin';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const MISCONFIGURED = 'allowlist is misconfigured';

describe('checkEmailAllowlist', () => {
  it('no allowlist (null) means no restriction', () => {
    expect(checkEmailAllowlist('anyone@evil.test', null)).toEqual({ allowed: true });
  });

  it.each([
    ['not JSON', 'not-json'],
    ['an empty string', ''],
    ['JSON null', 'null'],
    ['a JSON string, not an array', '"acme.com"'],
    ['a JSON object', '{"domain":"acme.com"}'],
    ['an empty list', '[]'],
    ['a list of numbers', '[123]'],
    ['a list with one non-string entry among valid ones', '["acme.com", 5]'],
    ['a list with a null entry', '["acme.com", null]'],
    ['a list with a nested array', '[["acme.com"]]'],
  ])('denies when the stored list is %s', (_label, stored) => {
    expect(checkEmailAllowlist('attacker@evil.test', stored)).toEqual({ allowed: false, reason: MISCONFIGURED });
    expect(checkEmailAllowlist('ceo@acme.com', stored)).toEqual({ allowed: false, reason: MISCONFIGURED });
  });

  it.each([
    ['an exact email', '["ceo@acme.com"]', 'ceo@acme.com'],
    ['an exact email, case-insensitively', '["CEO@Acme.com"]', 'ceo@ACME.com'],
    ['an @domain', '["@acme.com"]', 'anyone@acme.com'],
    ['a bare domain', '["acme.com"]', 'anyone@acme.com'],
    ['a *.domain subdomain', '["*.acme.com"]', 'anyone@eu.acme.com'],
    ['the second of several patterns', '["other.com", "acme.com"]', 'anyone@acme.com'],
    ['plus-addressing under a domain', '["acme.com"]', 'ceo+billing@acme.com'],
  ])('allows a match on %s', (_label, stored, email) => {
    expect(checkEmailAllowlist(email, stored)).toEqual({ allowed: true });
  });

  it('refuses an address with more than one @ (suffix patterns would otherwise match x@evil@acme.com)', () => {
    for (const stored of ['["acme.com"]', '["@acme.com"]', '["*.acme.com"]', '["bob@acme.com"]']) {
      expect(checkEmailAllowlist('x@evil@acme.com', stored).allowed, stored).toBe(false);
    }
    expect(checkEmailAllowlist('no-at-sign', '["acme.com"]').allowed).toBe(false);
  });

  it('a well-formed list that simply does not match denies with the not-in-allowlist reason, not the misconfigured one', () => {
    const r = checkEmailAllowlist('attacker@evil.test', '["acme.com"]');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not in allowlist/);
  });
});

describe('the lockout guard counts a malformed allowlist as "SSO admins cannot sign in"', () => {
  const sso = (allowlist: string | null) => ({
    password_enabled: 0, google_enabled: 1, google_client_id: 'id.apps.googleusercontent.com',
    google_client_secret_enc: 'enc', entra_enabled: 0, entra_tenant_id: null, entra_client_id: null,
    entra_client_secret_enc: null, email_allowlist: allowlist,
  } as any);
  const ssoAdmin = [{ email: 'admin@corp.com', password_hash: null, provider: 'google' }];

  it('a readable allowlist that includes the admin still lets them in', () => {
    expect(adminCanStillSignIn(sso('["corp.com"]'), ssoAdmin)).toBe(true);
    expect(adminCanStillSignIn(sso(null), ssoAdmin)).toBe(true);
  });

  it.each(['not-json', '[123]', '[]', '["corp.com", 1]'])('%s locks the SSO-only admin out, with the lockout reason', (stored) => {
    expect(adminCanStillSignIn(sso(stored), ssoAdmin)).toBe(false);
    expect(signInLockoutReason(sso(stored), ssoAdmin)).toMatch(/no admin able to sign in/);
  });

  it('a password admin can still sign in whatever the allowlist says (the allowlist does not apply to /auth/login)', () => {
    const pw = { ...sso('[123]'), password_enabled: 1 };
    expect(adminCanStillSignIn(pw, [{ email: 'a@corp.com', password_hash: 'h', provider: 'password' }])).toBe(true);
  });
});

describe('PUT /v1/admin/auth-config validates emailAllowlist', () => {
  const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-allowlist-${process.pid}.sqlite`);
  const SECRET = 'a'.repeat(64);
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };
  let server: any = null;
  let ctx: any = null;

  async function boot() {
    if (server) { await drainApp(server); server = null; }
    if (ctx) { await ctx.db.close(); ctx = null; }
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
    server = out.app.listen(0);
    ctx = out.ctx;
  }
  const stored = async (): Promise<string | null> => (await ctx.db.get("SELECT email_allowlist FROM auth_config WHERE org_id = 'org'")).email_allowlist;
  const put = (cookie: string, body: Record<string, unknown>) => supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send(body);
  /** Password off, Google complete, written directly (not via a save). */
  const ssoOnly = (allowlist: string | null) => ctx.db.run(
    `UPDATE auth_config SET password_enabled = 0, google_enabled = 1, google_client_id = 'id.apps.googleusercontent.com',
       google_client_secret_enc = ?, email_allowlist = ? WHERE org_id = 'org'`,
    [encryptSecret('shh', SECRET), allowlist],
  );
  let cookie = '';

  beforeEach(async () => {
    cleanup();
    await boot();
    await createPasswordUser(ctx.db, 'org', 'admin@corp.com', 'longenough1', 'admin');
    cookie = await loginAs(server, 'admin@corp.com', 'longenough1');
  });
  afterEach(async () => {
    if (server) await drainApp(server);
    if (ctx) await ctx.db.close();
    server = null; ctx = null;
    cleanup();
  });

  it.each([
    ['a number entry', [123]],
    ['a number among valid entries', ['acme.com', 5]],
    ['a null entry', ['acme.com', null]],
    ['a nested array', [['acme.com']]],
    ['an empty-string entry', ['']],
    ['a blank entry', ['   ']],
    ['free text', ['not an email']],
    ['an email with no domain', ['ceo@']],
    ['a lone @', ['@']],
    ['a lone wildcard', ['*.']],
    ['a TLD-wide wildcard', ['*.com']],
    ['a bare label with no dot', ['acme']],
    ['a URL', ['https://acme.com']],
    ['a path', ['acme.com/admin']],
    ['whitespace inside an email', ['a b@acme.com']],
    ['a mid-string wildcard', ['ac*me.com']],
    ['a very long entry', ['a'.repeat(300) + '.com']],
  ])('rejects %s with 400 and stores nothing', async (_label, list) => {
    const before = await stored();
    const r = await put(cookie, { emailAllowlist: list });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toMatch(/allowlist/i);
    expect(await stored()).toBe(before);
  });

  it.each([
    ['a string', 'acme.com'],
    ['an object', { domain: 'acme.com' }],
    ['a number', 7],
    ['null', null],
  ])('rejects %s where a list is required', async (_label, value) => {
    const r = await put(cookie, { emailAllowlist: value });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it('accepts every shape the matcher supports, and what it stores the matcher reads', async () => {
    const list = ['ceo@acme.com', '@acme.com', 'acme.com', '*.acme.com'];
    const r = await put(cookie, { emailAllowlist: list });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.emailAllowlist).toEqual(list);
    expect(checkEmailAllowlist('x@eu.acme.com', await stored())).toEqual({ allowed: true });
  });

  it('accepts an entry already stored, whatever its shape, but still refuses a NEW entry that does not fit', async () => {
    await ctx.db.run("UPDATE auth_config SET email_allowlist = '[\"corp\",\"acme.com\"]' WHERE org_id = 'org'");
    const keep = await put(cookie, { emailAllowlist: ['corp', 'acme.com', 'new.com'] });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect(JSON.parse((await stored())!)).toEqual(['corp', 'acme.com', 'new.com']);
    expect((await put(cookie, { emailAllowlist: ['corp', 'intranet'] })).status).toBe(400);
  });

  it('accepts uppercase, plus-addressing and the longest allowed entry', async () => {
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`;
    expect(longest.length).toBe(254);
    const r = await put(cookie, { emailAllowlist: ['CEO+tag@Acme.COM', longest] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await put(cookie, { emailAllowlist: [longest + 'x'] })).status).toBe(400);
  });

  it('clearing an unreadable allowlist with [] is a valid fix', async () => {
    await ssoOnly('[123]');
    const r = await put(cookie, { emailAllowlist: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('leaves the allowlist alone when the body does not mention it', async () => {
    await put(cookie, { emailAllowlist: ['acme.com'] });
    expect((await put(cookie, { passwordEnabled: true })).status).toBe(200);
    expect(JSON.parse((await stored())!)).toEqual(['acme.com']);
  });

  it('an empty list means "no allowlist": stored as NULL, so it can never read as a misconfigured empty list', async () => {
    await put(cookie, { emailAllowlist: ['acme.com'] });
    const r = await put(cookie, { emailAllowlist: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stored()).toBeNull();
    expect(r.body.emailAllowlist).toEqual([]);
    expect(checkEmailAllowlist('anyone@acme.com', await stored())).toEqual({ allowed: true });
  });

  it('GET still answers when the stored list is unreadable, and says so (the admin must be able to open the screen that fixes it)', async () => {
    await ctx.db.run("UPDATE auth_config SET email_allowlist = 'not-json' WHERE org_id = 'org'");
    const r = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.emailAllowlist).toEqual([]);
    expect(r.body.emailAllowlistMisconfigured).toBe(true);
  });

  it('GET reports a readable allowlist as not misconfigured', async () => {
    await put(cookie, { emailAllowlist: ['acme.com'] });
    const r = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.body.emailAllowlistMisconfigured).toBe(false);
  });

  it('refuses a save that would strand SSO-only admins behind an allowlist that excludes them', async () => {
    await ssoOnly(JSON.stringify(['corp.com']));
    const r = await put(cookie, { emailAllowlist: ['other.com'] });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toMatch(/no admin able to sign in/);
    expect(JSON.parse((await stored())!)).toEqual(['corp.com']);
  });

  it('still accepts the step that fixes an already-unreadable allowlist', async () => {
    await ssoOnly('[123]');
    const r = await put(cookie, { emailAllowlist: ['corp.com'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse((await stored())!)).toEqual(['corp.com']);
  });
});

describe('boot normalises the "[]" the old admin screen stored for "no allowlist"', () => {
  const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-allowlist-migrate-${process.pid}.sqlite`);
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };
  let server: any = null;
  let ctx: any = null;
  async function boot() {
    if (server) { await drainApp(server); server = null; }
    if (ctx) { await ctx.db.close(); ctx = null; }
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
    server = out.app.listen(0);
    ctx = out.ctx;
  }
  const stored = async () => (await ctx.db.get("SELECT email_allowlist FROM auth_config WHERE org_id = 'org'")).email_allowlist;

  beforeEach(async () => { cleanup(); await boot(); });
  afterEach(async () => {
    if (server) await drainApp(server);
    if (ctx) await ctx.db.close();
    server = null; ctx = null;
    cleanup();
  });

  it('turns a legacy "[]" into NULL once, so upgrading does not deny every SSO sign-in of an org that never set an allowlist', async () => {
    // The old admin screen stored "[]" for a blank field, which then meant "no restriction".
    await ctx.db.run("UPDATE auth_config SET email_allowlist = '[]' WHERE org_id = 'org'");
    await ctx.db.run("DELETE FROM system_state WHERE key = 'allowlist_empty_normalised'");
    await boot();
    expect(await stored()).toBeNull();
  });

  it('does it only once: a "[]" written afterwards is a misconfiguration and stays one', async () => {
    await boot();
    await ctx.db.run("UPDATE auth_config SET email_allowlist = '[]' WHERE org_id = 'org'");
    await boot();
    expect(await stored()).toBe('[]');
    expect(checkEmailAllowlist('anyone@acme.com', await stored())).toEqual({ allowed: false, reason: MISCONFIGURED });
  });

  it('leaves a real allowlist alone', async () => {
    await ctx.db.run("UPDATE auth_config SET email_allowlist = '[\"acme.com\"]' WHERE org_id = 'org'");
    await ctx.db.run("DELETE FROM system_state WHERE key = 'allowlist_empty_normalised'");
    await boot();
    expect(await stored()).toBe('["acme.com"]');
  });
});
