/**
 * Subtask 946a943c — bootstrap_tokens table + generator + first-boot stdout banner.
 *
 * Closes the TOFU race in /setup/initial-admin by gating it with a single-use
 * UUIDv4 the operator reads from the hub's stdout. This file covers the
 * generator + banner; the route change lives in subtask 442639e6.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureBootstrapToken } from '../auth/bootstrapToken';
import { openSqliteDb } from '../db/sqlite';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const dbFor = (label: string) =>
  path.join(os.tmpdir(), `agenfk-hub-bootstrap-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

const cleanup = (dbPath: string) => {
  for (const s of ['', '-wal', '-shm']) {
    const f = dbPath + s;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const UUID_V4 = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

describe('ensureBootstrapToken — generator', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = dbFor('gen'); });
  afterEach(() => { cleanup(dbPath); });

  it('returns a UUIDv4 on a fresh DB with no users', async () => {
    const db = await openSqliteDb(dbPath);
    try {
      const token = await ensureBootstrapToken(db);
      expect(token).toMatch(UUID_V4);
    } finally {
      await db.close();
    }
  });

  it('is idempotent: returns the same token on repeated calls within one process', async () => {
    const db = await openSqliteDb(dbPath);
    try {
      const t1 = await ensureBootstrapToken(db);
      const t2 = await ensureBootstrapToken(db);
      const t3 = await ensureBootstrapToken(db);
      expect(t1).not.toBeNull();
      expect(t2).toBe(t1);
      expect(t3).toBe(t1);
    } finally {
      await db.close();
    }
  });

  it('persists the token across DB close + reopen (restart-friendly)', async () => {
    let token1: string | null;
    {
      const db = await openSqliteDb(dbPath);
      token1 = await ensureBootstrapToken(db);
      await db.close();
    }
    const db2 = await openSqliteDb(dbPath);
    try {
      const token2 = await ensureBootstrapToken(db2);
      expect(token2).toBe(token1);
    } finally {
      await db2.close();
    }
  });

  it('returns null once a user already exists (setup is closed)', async () => {
    const db = await openSqliteDb(dbPath);
    try {
      // Seed a default org row first — createPasswordUser expects one.
      await db.run("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)", ['org', 'org']);
      await createPasswordUser(db, 'org', 'first@x', 'longenough1', 'admin');
      const token = await ensureBootstrapToken(db);
      expect(token).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('does not regenerate after admin creation: a stale token row is ignored', async () => {
    const db = await openSqliteDb(dbPath);
    try {
      const token1 = await ensureBootstrapToken(db);
      expect(token1).toMatch(UUID_V4);
      // Simulate the admin getting created (subtask 442639e6 will delete the
      // token row in the same tx; here we delete it manually and seed a user).
      await db.run("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)", ['org', 'org']);
      await createPasswordUser(db, 'org', 'first@x', 'longenough1', 'admin');
      await db.run('DELETE FROM bootstrap_tokens', []);
      const token2 = await ensureBootstrapToken(db);
      expect(token2).toBeNull();
      const rows = await db.all('SELECT token FROM bootstrap_tokens');
      expect(rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

describe('createHubApp — first-boot stdout banner', () => {
  let dbPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = dbFor('banner');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    cleanup(dbPath);
  });

  it('logs a banner containing a UUIDv4 token on first boot', async () => {
    const out = await createHubApp({
      dbPath,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
    });
    try {
      const all = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(all).toMatch(/first-run setup/i);
      const m = all.match(UUID_V4);
      expect(m, `expected a UUIDv4 in stdout, got:\n${all}`).not.toBeNull();
    } finally {
      await out.ctx.db.close();
    }
  });

  it('re-logs the same token when the hub restarts before setup is finished', async () => {
    const tokens: string[] = [];

    for (const _ of [1, 2]) {
      logSpy.mockClear();
      const out = await createHubApp({
        dbPath,
        secretKey: '0'.repeat(64),
        sessionSecret: 'test-session-secret-min-32-bytes-please',
        defaultOrgId: 'org',
      });
      const all = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      const m = all.match(UUID_V4);
      expect(m).not.toBeNull();
      tokens.push(m![0]);
      await out.ctx.db.close();
    }

    expect(tokens[0]).toBe(tokens[1]);
  });

  it('logs no banner once a user already exists', async () => {
    // Boot once to seed the token, then create an admin, then reboot.
    {
      const out = await createHubApp({
        dbPath,
        secretKey: '0'.repeat(64),
        sessionSecret: 'test-session-secret-min-32-bytes-please',
        defaultOrgId: 'org',
      });
      await createPasswordUser(out.ctx.db, 'org', 'first@x', 'longenough1', 'admin');
      await out.ctx.db.close();
    }
    logSpy.mockClear();
    const out2 = await createHubApp({
      dbPath,
      secretKey: '0'.repeat(64),
      sessionSecret: 'test-session-secret-min-32-bytes-please',
      defaultOrgId: 'org',
    });
    try {
      const all = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(all).not.toMatch(/first-run setup/i);
      expect(all).not.toMatch(UUID_V4);
    } finally {
      await out2.ctx.db.close();
    }
  });
});
