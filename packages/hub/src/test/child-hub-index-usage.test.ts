// The childHubId filter must SEEK, not scan (CGLAB-184).
//
// This filter exists to make a parent hub's board readable one group at a time.
// If it cannot use an index, selecting a hub reads every event or rollup the org
// has ever produced — the filter still returns the right rows, so no functional
// test notices, and the cost only shows up on a hub large enough to matter.
//
// The two tables need DIFFERENT SQL for the same question, which is the trap
// this file exists to hold shut:
//   events.child_hub_id        NULLable  -> COALESCE(child_hub_id,'') + an index
//                                           over that same expression
//   rollups_daily.child_hub_id NOT NULL  -> the plain column, which its existing
//                                           index and PRIMARY KEY already cover
// Wrapping the rollups column in COALESCE is a semantic no-op that blinds both,
// which is exactly how this regressed once already.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { childHubPredicate, HUB_COL_EVENTS, HUB_COL_ROLLUPS } from '../queries/childHub';

/** The plan for a query built the way the routes build it. */
function planFor(ddl: string[], table: string, col: string, hubs: string[]): string {
  const db = new DatabaseSync(':memory:');
  for (const s of ddl) db.exec(s);
  const p = childHubPredicate(hubs, col)!;
  const rows = db.prepare(
    `EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE org_id = ? AND ${p.sql}`,
  ).all('org', ...p.params) as Array<{ detail: string }>;
  db.close();
  return rows.map(r => r.detail).join(' | ');
}

const EVENTS_DDL = [
  `CREATE TABLE events (event_id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL, child_hub_id TEXT)`,
  `CREATE INDEX idx_events_org_childnorm_time ON events(org_id, COALESCE(child_hub_id, ''), occurred_at)`,
];
const ROLLUPS_DDL = [
  `CREATE TABLE rollups_daily (org_id TEXT NOT NULL, user_key TEXT NOT NULL, day TEXT NOT NULL,
     child_hub_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (org_id, child_hub_id, user_key, day))`,
  `CREATE INDEX idx_rollups_child ON rollups_daily(org_id, child_hub_id, day)`,
];

/** SQLite names the constrained columns in the plan; a seek lists child_hub_id
 *  (or the expression standing in for it) alongside org_id. */
const seeksOnHub = (plan: string) => /child_hub_id=\?|<expr>=\?/.test(plan);

describe('the childHubId filter uses an index on both tables', () => {
  for (const [label, hubs] of [
    ['one child hub', ['9f1c7e2a-0000-4000-8000-000000000001']],
    ['several child hubs', ['9f1c7e2a-0000-4000-8000-000000000001', '9f1c7e2a-0000-4000-8000-000000000002']],
    ['this hub', ['local']],
  ] as Array<[string, string[]]>) {
    it(`seeks on events — ${label}`, () => {
      const plan = planFor(EVENTS_DDL, 'events', HUB_COL_EVENTS, hubs);
      expect(seeksOnHub(plan), `plan was: ${plan}`).toBe(true);
    });

    it(`seeks on rollups_daily — ${label}`, () => {
      const plan = planFor(ROLLUPS_DDL, 'rollups_daily', HUB_COL_ROLLUPS, hubs);
      expect(seeksOnHub(plan), `plan was: ${plan}`).toBe(true);
    });
  }

  it('wrapping the rollups column in COALESCE would blind its index', () => {
    // The regression itself, pinned as a fact about SQLite rather than left as
    // a comment: this is WHY the two tables get different SQL.
    const plan = planFor(ROLLUPS_DDL, 'rollups_daily', HUB_COL_EVENTS,
      ['9f1c7e2a-0000-4000-8000-000000000001']);
    expect(seeksOnHub(plan)).toBe(false);
  });
});

// The block above pins the helper. This one pins what the ROUTES ask it for —
// which is where the regression actually lived: the helper was right, and
// /v1/metrics passed it the events spelling for a rollups_daily query. A test
// that calls the helper directly cannot see that, so it is not enough on its own.
describe('the routes ask for the right spelling per table', () => {
  const DB = path.join(os.tmpdir(), `agenfk-hub-idxuse-${process.pid}.sqlite`);
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };
  let app: any; let ctx: any; let cookie: string; let seen: Array<{ sql: string; params: any[] }>;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    seen = [];
    const realAll = ctx.db.all.bind(ctx.db);
    ctx.db.all = (sql: string, params: any[] = []) => { seen.push({ sql, params }); return realAll(sql, params); };
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  /** EXPLAIN the statement the route actually issued, against the real schema. */
  const planOf = async (match: RegExp) => {
    const q = seen.find(s => match.test(s.sql) && /child_hub_id/.test(s.sql));
    expect(q, `no query matching ${match} was issued`).toBeTruthy();
    const rows = await ctx.db.all<{ detail: string }>('EXPLAIN QUERY PLAN ' + q!.sql, q!.params);
    return rows.map(r => r.detail).join(' | ');
  };

  it('/v1/metrics seeks on rollups_daily when a child hub is selected', async () => {
    const r = await supertest(app)
      .get('/v1/metrics?childHubId=9f1c7e2a-0000-4000-8000-000000000001')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    const plan = await planOf(/FROM rollups_daily/);
    expect(plan, `plan was: ${plan}`).toMatch(/child_hub_id=\?/);
  });

  it('/v1/timeline seeks on events when this hub is selected', async () => {
    const r = await supertest(app).get('/v1/timeline?childHubId=local').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const plan = await planOf(/FROM events/);
    expect(plan, `plan was: ${plan}`).toMatch(/<expr>=\?/);
  });
});
