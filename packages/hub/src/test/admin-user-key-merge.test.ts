// Tests for POST /v1/admin/user-keys/merge — folding event-attribution
// identities together.
//
// The scenario this exists for: `user_key` is minted at ingest from the
// client's git identity, so one person arrives as several identities when their
// git config is wrong (`git config user.email = "x"` stores the literal `=`; an
// unset email falls back to the OS username). Hiding those keys throws the work
// away; this endpoint credits it to the real identity instead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-userkey-merge-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const MERGE = '/v1/admin/user-keys/merge';

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

let seq = 0;
async function seedEvent(
  db: any,
  orgId: string,
  userKey: string,
  occurredAt = '2026-07-29T10:00:00Z',
  type = 'item.closed',
) {
  const id = `ev-${++seq}`;
  await db.run(
    `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, 'inst-1', userKey, occurredAt, occurredAt, type, '{}'],
  );
  return id;
}

async function seedRollup(
  db: any,
  orgId: string,
  userKey: string,
  day: string,
  counts: Partial<Record<'events_count' | 'items_closed' | 'tokens_in' | 'tokens_out' | 'prs_opened', number>> = {},
) {
  await db.run(
    `INSERT INTO rollups_daily
       (org_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [
      orgId, userKey, day,
      counts.events_count ?? 0, counts.items_closed ?? 0,
      counts.tokens_in ?? 0, counts.tokens_out ?? 0, counts.prs_opened ?? 0,
    ],
  );
}

const userKeys = (db: any, orgId: string) =>
  db.all(`SELECT user_key, COUNT(*) AS n FROM events WHERE org_id = ? GROUP BY user_key ORDER BY user_key`, [orgId]);

describe('admin POST /v1/admin/user-keys/merge', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'cglab', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'cglab', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated requests', async () => {
      const r = await supertest(app).post(MERGE).send({ from: '=', to: 'a@x' });
      expect(r.status).toBe(401);
    });

    it('rejects non-admin sessions', async () => {
      const r = await supertest(app).post(MERGE).set('Cookie', cookieView).send({ from: '=', to: 'a@x' });
      expect(r.status).toBe(403);
    });
  });

  describe('validation', () => {
    const post = (body: any) => supertest(app).post(MERGE).set('Cookie', cookieAdmin).send(body);

    it('requires a non-empty `to`', async () => {
      expect((await post({ from: '=' })).status).toBe(400);
      expect((await post({ from: '=', to: '   ' })).status).toBe(400);
    });

    it('requires at least one `from` key that differs from `to`', async () => {
      expect((await post({ to: 'a@x' })).status).toBe(400);
      expect((await post({ to: 'a@x', from: [] })).status).toBe(400);
      // Self-merge is filtered out, leaving nothing to do — 400, not a no-op 200.
      expect((await post({ to: 'a@x', from: 'a@x' })).status).toBe(400);
      expect((await post({ to: 'a@x', from: ['A@X', '  '] })).status).toBe(400);
    });

    it('caps the number of source keys', async () => {
      const many = Array.from({ length: 51 }, (_, i) => `k${i}@x`);
      const r = await post({ to: 'a@x', from: many });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/at most 50/);
    });
  });

  describe('repointing events', () => {
    it('folds several identities into one and leaves a single user_key', async () => {
      await seedEvent(ctx.db, 'cglab', '=');
      await seedEvent(ctx.db, 'cglab', '=');
      await seedEvent(ctx.db, 'cglab', 'jonatansporn');
      await seedEvent(ctx.db, 'cglab', 'jonatan.sporn@cglab.com');

      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: ['=', 'jonatansporn'], to: 'jonatan.sporn@cglab.com' });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.events).toBe(3);
      expect(r.body.to).toBe('jonatan.sporn@cglab.com');
      expect(r.body.from).toEqual(['=', 'jonatansporn']);

      expect(await userKeys(ctx.db, 'cglab')).toEqual([
        { user_key: 'jonatan.sporn@cglab.com', n: 4 },
      ]);
    });

    it('accepts a bare string for a single source', async () => {
      await seedEvent(ctx.db, 'cglab', '=');
      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: '=', to: 'a@x' });
      expect(r.body.events).toBe(1);
      expect(await userKeys(ctx.db, 'cglab')).toEqual([{ user_key: 'a@x', n: 1 }]);
    });

    it('matches keys case-insensitively (the osUser fallback is not lowercased at ingest)', async () => {
      await seedEvent(ctx.db, 'cglab', 'JonatanSporn');
      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: 'jonatansporn', to: 'jonatan.sporn@cglab.com' });
      expect(r.body.events).toBe(1);
      expect(await userKeys(ctx.db, 'cglab')).toEqual([
        { user_key: 'jonatan.sporn@cglab.com', n: 1 },
      ]);
    });

    it('never touches another org', async () => {
      await seedEvent(ctx.db, 'other', '=');
      await seedEvent(ctx.db, 'cglab', '=');

      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: '=', to: 'a@x' });

      expect(r.body.events).toBe(1);
      expect(await userKeys(ctx.db, 'other')).toEqual([{ user_key: '=', n: 1 }]);
    });

    it('is idempotent — a second merge is a no-op', async () => {
      await seedEvent(ctx.db, 'cglab', '=');
      const body = { from: '=', to: 'a@x' };
      expect((await supertest(app).post(MERGE).set('Cookie', cookieAdmin).send(body)).body.events).toBe(1);
      const second = await supertest(app).post(MERGE).set('Cookie', cookieAdmin).send(body);
      expect(second.status).toBe(200);
      expect(second.body.events).toBe(0);
      expect(await userKeys(ctx.db, 'cglab')).toEqual([{ user_key: 'a@x', n: 1 }]);
    });
  });

  describe('rollups_daily', () => {
    const rollups = (orgId = 'cglab') => ctx.db.all(
      `SELECT user_key, day, events_count, items_closed, tokens_in, tokens_out, prs_opened
         FROM rollups_daily WHERE org_id = ? ORDER BY user_key, day`, [orgId],
    );

    it('sums same-day rows instead of colliding on the primary key', async () => {
      await seedRollup(ctx.db, 'cglab', '=', '2026-07-29', { events_count: 2, items_closed: 1, prs_opened: 1 });
      await seedRollup(ctx.db, 'cglab', 'jonatan.sporn@cglab.com', '2026-07-29', { events_count: 5, items_closed: 3, prs_opened: 2 });

      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: '=', to: 'jonatan.sporn@cglab.com' });

      expect(r.status).toBe(200);
      expect(r.body.rollupsRemoved).toBe(1);
      expect(await rollups()).toEqual([
        {
          user_key: 'jonatan.sporn@cglab.com', day: '2026-07-29',
          events_count: 7, items_closed: 4, tokens_in: 0, tokens_out: 0, prs_opened: 3,
        },
      ]);
    });

    it('moves a day the target has no row for', async () => {
      await seedRollup(ctx.db, 'cglab', '=', '2026-07-28', { events_count: 4 });
      await seedRollup(ctx.db, 'cglab', 'a@x', '2026-07-29', { events_count: 1 });

      await supertest(app).post(MERGE).set('Cookie', cookieAdmin).send({ from: '=', to: 'a@x' });

      const rows = await rollups();
      expect(rows.map((r: any) => [r.user_key, r.day, r.events_count])).toEqual([
        ['a@x', '2026-07-28', 4],
        ['a@x', '2026-07-29', 1],
      ]);
    });

    it('preserves token counts a recompute from events would have zeroed', async () => {
      // rollup.ts hardcodes tokens_in/tokens_out to 0 when aggregating from
      // `events`, so summing the stored rows is the only way these survive.
      await seedRollup(ctx.db, 'cglab', '=', '2026-07-29', { tokens_in: 100, tokens_out: 20 });
      await seedRollup(ctx.db, 'cglab', 'a@x', '2026-07-29', { tokens_in: 7, tokens_out: 3 });

      await supertest(app).post(MERGE).set('Cookie', cookieAdmin).send({ from: '=', to: 'a@x' });

      const rows = await rollups();
      expect(rows).toHaveLength(1);
      expect(rows[0].tokens_in).toBe(107);
      expect(rows[0].tokens_out).toBe(23);
    });

    it('leaves another org\'s rollups alone', async () => {
      await seedRollup(ctx.db, 'other', '=', '2026-07-29', { events_count: 9 });
      await seedRollup(ctx.db, 'cglab', '=', '2026-07-29', { events_count: 1 });

      await supertest(app).post(MERGE).set('Cookie', cookieAdmin).send({ from: '=', to: 'a@x' });

      expect(await rollups('other')).toEqual([{
        user_key: '=', day: '2026-07-29', events_count: 9,
        items_closed: 0, tokens_in: 0, tokens_out: 0, prs_opened: 0,
      }]);
    });
  });

  describe('companion rows', () => {
    it('repoints the installation git email and drops a stale hide', async () => {
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['inst-1', 'cglab', '2026-07-01T00:00:00Z', '2026-07-29T00:00:00Z', 'jonatansporn', '=', '='],
      );
      await supertest(app).post('/v1/admin/hidden-users').set('Cookie', cookieAdmin).send({ userKey: '=' });

      const r = await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: '=', to: 'jonatan.sporn@cglab.com' });

      expect(r.body.installations).toBe(1);
      expect(r.body.hiddenRemoved).toBe(1);

      const inst = await ctx.db.get(`SELECT git_email FROM installations WHERE id = ?`, ['inst-1']);
      expect(inst.git_email).toBe('jonatan.sporn@cglab.com');

      const hidden = await supertest(app).get('/v1/admin/hidden-users').set('Cookie', cookieAdmin);
      expect(hidden.body).toEqual([]);
    });
  });

  describe('dashboard visibility', () => {
    it('collapses the /v1/users list down to the surviving identity', async () => {
      await seedEvent(ctx.db, 'cglab', '=');
      await seedEvent(ctx.db, 'cglab', 'jonatansporn');
      await seedEvent(ctx.db, 'cglab', 'jonatan.sporn@cglab.com');

      await supertest(app).post(MERGE).set('Cookie', cookieAdmin)
        .send({ from: ['=', 'jonatansporn'], to: 'jonatan.sporn@cglab.com' });

      const users = await supertest(app).get('/v1/users').set('Cookie', cookieAdmin);
      expect(users.status).toBe(200);
      expect(users.body.map((u: any) => u.user_key)).toEqual(['jonatan.sporn@cglab.com']);
      expect(Number(users.body[0].events_count)).toBe(3);
    });
  });
});

describe('USER_KEY_TABLES covers every user_key-bearing table (regression pin)', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('matches what sqlite_master + pragma_table_info report', async () => {
    const { ctx } = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'cglab',
    });
    try {
      const mod = await import('../routes/userKeyMerge');
      const declared = (mod as any).USER_KEY_TABLES as Record<string, readonly string[]>;
      const handled = [...declared.repoint, ...declared.sum, ...declared.drop];

      const tables = await ctx.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      const introspected: string[] = [];
      for (const t of tables) {
        const cols = await ctx.db.all<{ name: string }>(`PRAGMA table_info(${t.name})`);
        if (cols.some((c: any) => c.name === 'user_key')) introspected.push(t.name);
      }
      // Any new user_key column must be given an explicit merge strategy.
      expect([...handled].sort()).toEqual(introspected.sort());
    } finally {
      await ctx.db.close();
    }
  });
});
