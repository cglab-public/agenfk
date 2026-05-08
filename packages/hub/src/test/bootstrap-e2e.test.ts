/**
 * Subtask f4223258 — full first-boot bootstrap flow, run against both
 * SQLite and pg-mem so the token gate is exercised on every supported
 * adapter. Each scenario boots createHubApp, captures the stdout banner,
 * extracts the token, hits /setup/initial-admin, and asserts both the
 * server response and the resulting DB state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import type { HubDb } from '../db/types';

const SECRET = '0'.repeat(64);
const UUID_V4 = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

const dbFor = (label: string) =>
  path.join(os.tmpdir(), `agenfk-hub-bootstrap-e2e-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

const cleanup = (dbPath: string) => {
  for (const s of ['', '-wal', '-shm']) {
    const f = dbPath + s;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

interface BackendHarness {
  name: 'sqlite' | 'postgres';
  /** Fresh DB + tracking for cleanup. Returns a boot fn that opens against the same DB across calls. */
  setup: () => Promise<{ boot: () => Promise<{ app: any; db: HubDb; close: () => Promise<void> }>; teardown: () => Promise<void> }>;
}

const sqliteHarness: BackendHarness = {
  name: 'sqlite',
  setup: async () => {
    const dbPath = dbFor('e2e');
    return {
      boot: async () => {
        const out = await createHubApp({
          dbPath,
          secretKey: SECRET,
          sessionSecret: 'test-session-secret-min-32-bytes-please',
          defaultOrgId: 'org',
        });
        return { app: out.app, db: out.ctx.db, close: () => out.ctx.db.close() };
      },
      teardown: async () => { cleanup(dbPath); },
    };
  },
};

const pgHarness: BackendHarness = {
  name: 'postgres',
  setup: async () => {
    // pg-mem is in-process; share one HubDb instance across boots so a
    // restart sees the same state. The `db` override on createHubApp means
    // the first boot creates schema; the second skips re-opening.
    const db = await openPgMemDb();
    return {
      boot: async () => {
        const out = await createHubApp({
          dbPath: '/tmp/unused-pg-mem.sqlite',
          secretKey: SECRET,
          sessionSecret: 'test-session-secret-min-32-bytes-please',
          defaultOrgId: 'org',
          db,
        });
        // Don't actually close the shared db on per-boot teardown.
        return { app: out.app, db, close: async () => { /* shared */ } };
      },
      teardown: async () => { await db.close(); },
    };
  },
};

for (const harness of [sqliteHarness, pgHarness]) {
  describe(`first-boot bootstrap (${harness.name})`, () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let h: Awaited<ReturnType<BackendHarness['setup']>>;

    beforeEach(async () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      h = await harness.setup();
    });

    afterEach(async () => {
      logSpy.mockRestore();
      await h.teardown();
    });

    const extractToken = (): string => {
      const all = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      const m = all.match(UUID_V4);
      if (!m) throw new Error(`expected a UUIDv4 in stdout, got:\n${all}`);
      return m[0];
    };

    it('end-to-end: token from stdout → /setup/initial-admin → admin row created and token consumed', async () => {
      const { app, db, close } = await h.boot();
      try {
        const token = extractToken();

        const r = await supertest(app)
          .post('/setup/initial-admin')
          .send({ token, email: 'admin@x', password: 'longenough1' });
        expect(r.status).toBe(201);

        const remaining = await db.all('SELECT token FROM bootstrap_tokens');
        expect(remaining).toHaveLength(0);

        const users = await db.all<{ email: string; role: string }>("SELECT email, role FROM users");
        expect(users).toHaveLength(1);
        expect(users[0].email).toBe('admin@x');
        expect(users[0].role).toBe('admin');

        // Negative: second attempt returns 409 (single-use).
        const second = await supertest(app)
          .post('/setup/initial-admin')
          .send({ token, email: 'second@x', password: 'longenough2' });
        expect(second.status).toBe(409);

        // The newly-created admin can log in via /auth/login.
        const login = await supertest(app)
          .post('/auth/login')
          .send({ email: 'admin@x', password: 'longenough1' });
        expect(login.status).toBe(200);
        expect(login.body.role).toBe('admin');
      } finally {
        await close();
      }
    });

    it('wrong token is rejected with 401 and the bootstrap row stays available for a retry', async () => {
      const { app, db, close } = await h.boot();
      try {
        const token = extractToken();

        const wrong = await supertest(app)
          .post('/setup/initial-admin')
          .send({ token: '00000000-0000-4000-8000-000000000000', email: 'admin@x', password: 'longenough1' });
        expect(wrong.status).toBe(401);
        expect(wrong.body.error).toMatch(/invalid token/i);

        const usersAfter401 = await db.all('SELECT id FROM users');
        expect(usersAfter401).toHaveLength(0);
        const stillHave = await db.all('SELECT token FROM bootstrap_tokens');
        expect(stillHave).toHaveLength(1);

        // Operator now retries with the right token.
        const ok = await supertest(app)
          .post('/setup/initial-admin')
          .send({ token, email: 'admin@x', password: 'longenough1' });
        expect(ok.status).toBe(201);
      } finally {
        await close();
      }
    });

    it('restart while setup is still pending re-logs the same token; restart after setup logs nothing', async () => {
      // Boot 1: token logged.
      const first = await h.boot();
      const token1 = extractToken();
      await first.close();

      // Boot 2: same token re-logged because setup is still open.
      logSpy.mockClear();
      const second = await h.boot();
      const token2 = extractToken();
      expect(token2).toBe(token1);

      // Complete setup.
      const r = await supertest(second.app)
        .post('/setup/initial-admin')
        .send({ token: token2, email: 'admin@x', password: 'longenough1' });
      expect(r.status).toBe(201);
      await second.close();

      // Boot 3: setup is closed, no banner.
      logSpy.mockClear();
      const third = await h.boot();
      try {
        const all = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
        expect(all).not.toMatch(UUID_V4);
        expect(all).not.toMatch(/first-run setup/i);
      } finally {
        await third.close();
      }
    });
  });
}
