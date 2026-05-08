/**
 * Subtask 442639e6 — token-gated POST /setup/initial-admin.
 *
 * Replaces the old open body shape (email + password) with a three-field
 * body (token + email + password). Token validation runs first; only on
 * match do we accept the email/password and atomically delete the token
 * in the same transaction that creates the admin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';

const dbFor = (label: string) =>
  path.join(os.tmpdir(), `agenfk-hub-setup-token-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

const cleanup = (dbPath: string) => {
  for (const s of ['', '-wal', '-shm']) {
    const f = dbPath + s;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const boot = async (dbPath: string) => {
  const out = await createHubApp({
    dbPath,
    secretKey: '0'.repeat(64),
    sessionSecret: 'test-session-secret-min-32-bytes-please',
    defaultOrgId: 'org',
  });
  const row = await out.ctx.db.get<{ token: string }>('SELECT token FROM bootstrap_tokens LIMIT 1');
  return { ...out, token: row?.token ?? null };
};

describe('POST /setup/initial-admin — token gate', () => {
  let dbPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = dbFor('gate');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    cleanup(dbPath);
  });

  it('creates the admin and consumes the token when the body has a matching token', async () => {
    const { app, ctx, token } = await boot(dbPath);
    try {
      expect(token).toBeTruthy();
      const r = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token, email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(201);

      const left = await ctx.db.all('SELECT token FROM bootstrap_tokens');
      expect(left).toHaveLength(0);

      const users = await ctx.db.all<{ email: string; role: string }>("SELECT email, role FROM users");
      expect(users).toHaveLength(1);
      expect(users[0].email).toBe('admin@x');
      expect(users[0].role).toBe('admin');
    } finally {
      await ctx.db.close();
    }
  });

  it('returns 409 when an admin already exists (single-use enforced)', async () => {
    const { app, ctx, token } = await boot(dbPath);
    try {
      const ok = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token, email: 'first@x', password: 'longenough1' });
      expect(ok.status).toBe(201);

      const second = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token, email: 'second@x', password: 'longenough2' });
      expect(second.status).toBe(409);
    } finally {
      await ctx.db.close();
    }
  });

  it('returns 401 with a generic message when the token is wrong; row is preserved', async () => {
    const { app, ctx } = await boot(dbPath);
    try {
      const r = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token: '00000000-0000-4000-8000-000000000000', email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/invalid token/i);
      // Token row preserved so a legit operator can still finish setup.
      const left = await ctx.db.all('SELECT token FROM bootstrap_tokens');
      expect(left).toHaveLength(1);
      // No user was created.
      const users = await ctx.db.all('SELECT id FROM users');
      expect(users).toHaveLength(0);
    } finally {
      await ctx.db.close();
    }
  });

  it('returns 401 when the token field is missing entirely', async () => {
    const { app, ctx } = await boot(dbPath);
    try {
      const r = await supertest(app)
        .post('/setup/initial-admin')
        .send({ email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/invalid token/i);
    } finally {
      await ctx.db.close();
    }
  });

  it('returns 401 when the token is the empty string', async () => {
    const { app, ctx } = await boot(dbPath);
    try {
      const r = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token: '', email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(401);
    } finally {
      await ctx.db.close();
    }
  });

  it('returns 400 for a too-short password even with a valid token (validation still applies)', async () => {
    const { app, ctx, token } = await boot(dbPath);
    try {
      const r = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token, email: 'admin@x', password: 'short' });
      expect(r.status).toBe(400);
      // Token must NOT be consumed by a 400.
      const left = await ctx.db.all('SELECT token FROM bootstrap_tokens');
      expect(left).toHaveLength(1);
    } finally {
      await ctx.db.close();
    }
  });

  it('a token captured before restart still works after a restart (persistence)', async () => {
    const first = await boot(dbPath);
    const tokenBeforeRestart = first.token!;
    await first.ctx.db.close();

    const second = await boot(dbPath);
    try {
      expect(second.token).toBe(tokenBeforeRestart);
      const r = await supertest(second.app)
        .post('/setup/initial-admin')
        .send({ token: tokenBeforeRestart, email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(201);
    } finally {
      await second.ctx.db.close();
    }
  });

  it('returns 401 with the same message regardless of whether the token is wrong or missing (no field-level disclosure)', async () => {
    const { app, ctx } = await boot(dbPath);
    try {
      const wrong = await supertest(app)
        .post('/setup/initial-admin')
        .send({ token: '00000000-0000-4000-8000-000000000000', email: 'a@b', password: 'longenough1' });
      const missing = await supertest(app)
        .post('/setup/initial-admin')
        .send({ email: 'a@b', password: 'longenough1' });
      expect(wrong.status).toBe(401);
      expect(missing.status).toBe(401);
      expect(wrong.body.error).toBe(missing.body.error);
    } finally {
      await ctx.db.close();
    }
  });
});
