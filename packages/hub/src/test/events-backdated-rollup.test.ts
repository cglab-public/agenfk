/**
 * #223: /v1/events rolls up the past days it actually stored.
 *
 * recomputeRollups is forward-only by default: the 5-minute timer and the
 * metrics routes recompute from MAX(day) already rolled up. An event dated
 * before that anchor — a spoke outbox catching up after days offline, or a
 * deadletter requeue resending refused events with their ORIGINAL occurredAt —
 * landed in `events` (totals, PR overview) but never in `rollups_daily`, so the
 * per-day series and per-person rollups never showed it. Federation delivery
 * already repairs its own backdated days (routes/federation.ts); direct ingest
 * now does the same, for the days of events it ingested and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { recomputeRollups, utcDayOf } from '../rollup';
import { drainApp } from './helpers/drainApp';

let __server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-backdated-rollup-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const event = (overrides: Partial<any> = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: `${today()}T10:00:00.000Z`,
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  type: 'pr.opened',
  projectId: 'p1',
  itemId: 'i1',
  payload: { prNumber: 2, repo: 'acme/app' },
  ...overrides,
});

describe('/v1/events recomputes rollups for backdated ingested days (#223)', () => {
  let ctx: any;
  let token: string;

  const post = (events: any[], tok = token) => supertest(__server).post('/v1/events')
    .set('Authorization', `Bearer ${tok}`)
    .set('X-Installation-Id', 'inst-1')
    .send({ events });

  const rollupRow = (org: string, day: string) =>
    ctx.db.get('SELECT prs_opened, events_count FROM rollups_daily WHERE org_id = ? AND day = ?', [org, day]);

  /** An anchor: today's activity, rolled up the way the timer does it. */
  async function anchorToday(): Promise<void> {
    expect((await post([event()])).status).toBe(200);
    await recomputeRollups(ctx.db);
    expect(await rollupRow('org', today())).toBeTruthy();
  }

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    ctx = out.ctx;
    token = await issueApiKey(ctx.db, 'org', 'test');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
  });

  it('a backdated pr.opened reaches its own day in rollups_daily', async () => {
    await anchorToday();
    const old = daysAgo(3);
    const r = await post([event({ occurredAt: `${old}T22:37:09.924Z` })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(await rollupRow('org', old)).toMatchObject({ prs_opened: 1, events_count: 1 });
  });

  it('a duplicate (already stored) triggers no recompute', async () => {
    await anchorToday();
    const old = daysAgo(3);
    const e = event({ occurredAt: `${old}T10:00:00.000Z` });
    await post([e]);
    expect(await rollupRow('org', old)).toBeTruthy();
    // Make the day's rollup stale on purpose: only a recompute would bring it back.
    await ctx.db.run('DELETE FROM rollups_daily WHERE org_id = ? AND day = ?', ['org', old]);
    const r = await post([e]);
    expect(r.body.ingested).toBe(0);
    expect(await rollupRow('org', old)).toBeFalsy();
  });

  it('a refused backdated event triggers no recompute', async () => {
    await anchorToday();
    const old = daysAgo(4);
    const r = await post([event({ occurredAt: `${old}T10:00:00.000Z`, orgId: 'someone-else' })]);
    expect(r.body.rejected).toBe(1);
    expect(await rollupRow('org', old)).toBeFalsy();
    expect(await rollupRow('someone-else', old)).toBeFalsy();
  });

  it('recomputes only the ingesting org', async () => {
    await anchorToday();
    const old = daysAgo(5);
    const other = await issueApiKey(ctx.db, 'org2', 'other');
    await post([event({ orgId: 'org2', installationId: 'inst-2', occurredAt: `${old}T09:00:00.000Z` })], other);
    await ctx.db.run('DELETE FROM rollups_daily WHERE org_id = ?', ['org2']);

    await post([event({ occurredAt: `${old}T10:00:00.000Z` })]);
    expect(await rollupRow('org', old)).toBeTruthy();
    expect(await rollupRow('org2', old)).toBeFalsy();
  });

  it('does nothing extra with no anchor yet — the next timer run rolls up everything', async () => {
    const old = daysAgo(3);
    const r = await post([event({ occurredAt: `${old}T10:00:00.000Z` })]);
    expect(r.status).toBe(200);
    const n = await ctx.db.get('SELECT COUNT(*) AS c FROM rollups_daily');
    expect(Number(n.c)).toBe(0);
  });

  // Review finding 1: one future-dated event must not make every live batch
  // from every tenant pay for a recompute.
  it('a future anchor does not make live (today) batches recompute, while backdated ones still do', async () => {
    await anchorToday();
    await ctx.db.run(
      'INSERT INTO rollups_daily (org_id, child_hub_id, user_key, day, events_count) VALUES (?, ?, ?, ?, ?)',
      ['org', '', 'someone', '2099-01-01', 1],
    );
    await ctx.db.run('DELETE FROM rollups_daily WHERE org_id = ? AND day = ?', ['org', today()]);
    expect((await post([event()])).body.ingested).toBe(1);
    expect(await rollupRow('org', today())).toBeFalsy();

    const old = daysAgo(2);
    await post([event({ occurredAt: `${old}T10:00:00.000Z` })]);
    expect(await rollupRow('org', old)).toBeTruthy();
  });

  it('a failing recompute still acknowledges the stored events', async () => {
    await anchorToday();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ctx.db.run('DROP TABLE rollups_daily');
    const old = daysAgo(3);
    const e = event({ occurredAt: `${old}T10:00:00.000Z` });
    const r = await post([e]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(await ctx.db.get('SELECT event_id FROM events WHERE event_id = ?', [e.eventId])).toBeTruthy();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/rollup/i);
  });
});

// Review finding 8: the day must be the one SQLite's date(occurred_at) gives,
// whatever the hub host's time zone.
describe('utcDayOf', () => {
  it.each([
    ['2026-10-13T23:59:59.999Z', '2026-10-13'],
    ['2026-10-13T22:00:00-03:00', '2026-10-14'],
    ['2026-10-14T01:00:00+0200', '2026-10-13'],
    // No offset: UTC, as SQLite reads it — not the host's local time.
    ['2026-10-13T23:30:00', '2026-10-13'],
    ['2026-10-13T00:30:00.000', '2026-10-13'],
    ['2026-10-13 23:30:00', '2026-10-13'],
    ['2026-10-13', '2026-10-13'],
    ['not a date at all', 'not a date'],
  ])('%s -> %s', (input, day) => {
    expect(utcDayOf(input)).toBe(day);
  });
});
