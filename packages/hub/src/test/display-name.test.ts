/**
 * BUG f44b1128 / CGLAB-354 — the signed-in user must be identifiable by name.
 *
 * The hub asked its identity providers for `profile` from day one but never
 * consumed the name they sent back: the callbacks read only subject + email,
 * `users` had nowhere to put a name, and /auth/me returned the raw session.
 * The sidebar therefore printed a UUID for every user, on every provider.
 *
 * These tests pin the whole path — claim captured, column present (including
 * on databases that predate it), name exposed by the API.
 *
 * SCOPE: this file exercises claim PLUMBING, not token security. The
 * jsonwebtoken mock below returns the claims verbatim, so the audience and
 * issuer pinning in verifyIdToken is inert here — that is covered by
 * entra.test.ts. Do not read a green run of this file as SSO verification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import axios from 'axios';
import { createHubApp } from '../server';
import { encryptSecret } from '../crypto';
import { _resetEntraDiscoveryCache } from '../auth/entra';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

let mockClaims: any = {};

// Stub ONLY the async id-token verification (the callback form the Entra
// router uses). Session cookies are verified through the very same function,
// synchronously and without a callback — stubbing that form too made every
// signed-in request 401, which is a mocking artefact, not the bug under test.
vi.mock('jsonwebtoken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonwebtoken')>();
  const realVerify = (actual.default ?? actual).verify;
  const verify = ((token: any, key: any, opts: any, cb: any) => {
    const done = typeof cb === 'function' ? cb : typeof opts === 'function' ? opts : null;
    if (done) return done(null, mockClaims);
    return (realVerify as any)(token, key, opts);
  }) as any;
  return { ...actual, verify, default: { ...(actual.default ?? actual), verify } };
});

vi.mock('jwks-rsa', () => ({
  default: () => ({ getSigningKey: (_k: any, cb: any) => cb(null, { getPublicKey: () => 'pem' }) }),
}));

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-display-name-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = (file = TEST_DB) => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const DISCOVERY = {
  authorization_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/tenant-uuid/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/tenant-uuid/v2.0',
};

const enableEntra = (db: any) => db.run(
  `UPDATE auth_config SET entra_enabled = 1, entra_tenant_id = 'tenant-uuid',
   entra_client_id = 'app-client-id', entra_client_secret_enc = ? WHERE org_id = 'org'`,
  [encryptSecret('e-secret', SECRET)],
);

const enableGoogle = (db: any) => db.run(
  `UPDATE auth_config SET google_enabled = 1, google_client_id = 'g-client-id',
   google_client_secret_enc = ? WHERE org_id = 'org'`,
  [encryptSecret('g-secret', SECRET)],
);

/** An admin-invited user who has not signed in through an SSO provider yet. */
const invite = (db: any, id: string, email: string) => db.run(
  'INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, ?, ?, ?)',
  [id, 'org', email, null, 'password', 'viewer'],
);

/** Drive a full SSO round-trip and return the callback response. */
const signIn = async (app: any, provider: 'entra' | 'google') => {
  const start = await supertest(app).get(`/auth/${provider}/start`).redirects(0);
  const stateCookie = start.headers['set-cookie']?.[0];
  const state = decodeURIComponent(/agenfk_hub_oauth_state=([^;]+)/.exec(stateCookie!)![1]);
  return supertest(app)
    .get(`/auth/${provider}/callback?code=abc&state=${state}`)
    .set('Cookie', stateCookie!)
    .redirects(0);
};

describe('signed-in user display name', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    // Reset the identity between tests: inherited claims would let a later
    // test pass on the previous test's user without ever saying so.
    mockClaims = {};
    _resetEntraDiscoveryCache();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  describe('schema', () => {
    it('users has a nullable name column', async () => {
      await invite(ctx.db, 'u1', 'nameless@acme.com');
      const row = await ctx.db.get<any>('SELECT name FROM users WHERE id = ?', ['u1']);
      expect(row).toBeDefined();
      expect(row.name ?? null).toBeNull();
    });
  });

  describe('Entra', () => {
    beforeEach(async () => {
      await enableEntra(ctx.db);
      vi.spyOn(axios, 'get').mockResolvedValue({ data: DISCOVERY } as any);
    });

    it('persists the name claim on sign-in', async () => {
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: 'Bob Marley' };

      const cb = await signIn(app, 'entra');
      expect(cb.status).toBe(302);
      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.name).toBe('Bob Marley');
    });

    it('refreshes the stored name when it changes at the provider', async () => {
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValue({ data: { id_token: 'fake.jwt' } } as any);

      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: 'Bob Marley' };
      await signIn(app, 'entra');
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: 'Roberta Marley' };
      await signIn(app, 'entra');

      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.name).toBe('Roberta Marley');
    });

    it('signs in without a name claim and leaves the name unset', async () => {
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com' };

      const cb = await signIn(app, 'entra');
      expect(cb.status).toBe(302);
      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.name ?? null).toBeNull();
    });

    it('keeps a name already on the row when the provider sends none', async () => {
      // The link-by-email branch: the row exists with a name (say it was set
      // by an earlier Google sign-in) but is not yet bound to this provider.
      // Binding it must not blank the name just because this token lacks one.
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      await ctx.db.run('UPDATE users SET name = ? WHERE id = ?', ['Bob Marley', 'u-pre']);
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com' };

      await signIn(app, 'entra');

      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.provider).toBe('entra');
      expect(row.name).toBe('Bob Marley');
    });

    it('strips control characters and bounds an over-long name', async () => {
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: `Bob\u202E\nMarley${'x'.repeat(400)}` };

      await signIn(app, 'entra');

      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.name.length).toBeLessThanOrEqual(200);
      expect(row.name.startsWith('BobMarley')).toBe(true);
      expect(/[\u0000-\u001F\u202A-\u202E]/.test(row.name)).toBe(false);
    });

    it('carries the captured name through to /auth/me', async () => {
      // The seam: SSO writes the name, the API hands it to the UI. Tested
      // apart, each half can be right while the pair is broken.
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { id_token: 'fake.jwt' } } as any);
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: 'Bob Marley' };

      const cb = await signIn(app, 'entra');
      const session = (cb.headers['set-cookie'] as unknown as string[])
        .find((c: string) => c.startsWith('agenfk_hub_session='));
      const me = await supertest(app).get('/auth/me').set('Cookie', session!);

      expect(me.status).toBe(200);
      expect(me.body.name).toBe('Bob Marley');
      expect(me.body.email).toBe('bob@acme.com');
    });

    it('never overwrites a stored name with a blank claim', async () => {
      await invite(ctx.db, 'u-pre', 'bob@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValue({ data: { id_token: 'fake.jwt' } } as any);

      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: 'Bob Marley' };
      await signIn(app, 'entra');
      mockClaims = { oid: 'oid-1', email: 'bob@acme.com', name: '   ' };
      await signIn(app, 'entra');

      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-pre']);
      expect(row.name).toBe('Bob Marley');
    });
  });

  describe('Google', () => {
    it('persists the name from userinfo on sign-in', async () => {
      await enableGoogle(ctx.db);
      await invite(ctx.db, 'u-g', 'ada@acme.com');
      vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { access_token: 'tok' } } as any);
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        data: { sub: 'g-sub-1', email: 'ada@acme.com', email_verified: true, name: 'Ada Lovelace' },
      } as any);

      const cb = await signIn(app, 'google');
      expect(cb.status).toBe(302);
      const row = await ctx.db.get<any>('SELECT * FROM users WHERE id = ?', ['u-g']);
      expect(row.name).toBe('Ada Lovelace');
    });
  });

  describe('GET /auth/me', () => {
    const login = async () => {
      const r = await supertest(app).post('/auth/login').send({ email: 'ada@acme.com', password: 'rightpassword' });
      return r.headers['set-cookie']?.[0];
    };

    it('exposes the name and email alongside the session fields', async () => {
      const u = await createPasswordUser(ctx.db, 'org', 'ada@acme.com', 'rightpassword', 'admin');
      await ctx.db.run('UPDATE users SET name = ? WHERE id = ?', ['Ada Lovelace', u.id]);

      const me = await supertest(app).get('/auth/me').set('Cookie', (await login())!);
      expect(me.status).toBe(200);
      expect(me.body.name).toBe('Ada Lovelace');
      expect(me.body.email).toBe('ada@acme.com');
      // The existing session fields must survive — the UI still needs them.
      expect(me.body.userId).toBe(u.id);
      expect(me.body.orgId).toBe('org');
      expect(me.body.role).toBe('admin');
    });

    it('returns a null name when the user has none, still exposing the email', async () => {
      await createPasswordUser(ctx.db, 'org', 'ada@acme.com', 'rightpassword', 'viewer');
      const me = await supertest(app).get('/auth/me').set('Cookie', (await login())!);
      expect(me.status).toBe(200);
      expect(me.body.name ?? null).toBeNull();
      expect(me.body.email).toBe('ada@acme.com');
    });
  });
});

// NOT TESTED HERE: the Postgres side of the users.name migration. The branch
// only runs when `users` already exists without the column, which means
// bootstrapping over a pre-existing table — and pg-mem, the only Postgres
// harness available in this suite, rejects `CREATE TABLE IF NOT EXISTS` when
// the table is already there. Attempting it produces a parser error, not a
// meaningful assertion. The SQLite equivalent below IS covered; the Postgres
// path is held by inspection and by the schema-scoped probe it shares with
// the rest of db/postgres.ts.

describe('legacy database migration', () => {
  const LEGACY_DB = path.join(os.tmpdir(), `agenfk-hub-display-name-legacy-${process.pid}.sqlite`);

  afterEach(() => cleanup(LEGACY_DB));

  it('adds name to a users table created before the column existed', async () => {
    cleanup(LEGACY_DB);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const seed = new DatabaseSync(LEGACY_DB);
    seed.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      provider TEXT NOT NULL,
      provider_subject TEXT,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    )`);
    seed.exec(`INSERT INTO users (id, org_id, email, provider, role)
               VALUES ('old-1', 'org', 'legacy@acme.com', 'password', 'admin')`);
    seed.close();

    const out = await createHubApp({
      dbPath: LEGACY_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    try {
      const row = await out.ctx.db.get<any>('SELECT id, name FROM users WHERE id = ?', ['old-1']);
      expect(row.id).toBe('old-1');
      expect(row.name ?? null).toBeNull();
    } finally {
      await drainApp(out.app);
      await out.ctx.db.close();
    }
  });
});
