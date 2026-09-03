// Story b704ff87 (CGLAB-117, epic a3690599): per-event rejection reasons in the
// /v1/events response.
//
// The 31 Aug 2026 incident: a clobbered fixture hub.json made 57 events fail
// the hub's org check; the response carried only a bare `rejected` counter, so
// nobody on either side could say WHICH events were lost — and the flusher
// deleted them anyway. These tests pin the new `rejections: [{eventId, reason}]`
// payload alongside the unchanged legacy counters.
//
// Reason codes:
//   invalid               — fails isValidEvent (eventId best-effort: null when
//                            the event has no usable eventId — often the reason
//                            it is invalid)
//   org_mismatch          — e.orgId !== the token's org (the tenancy watermark)
//   foreign_installation  — event names an installation foreign to the
//                            presenting key: an unbound key naming another
//                            org's installation, or a bound key naming anything
//                            but its own installation
//   hidden_user           — admin-hidden identity (also counted in hiddenDropped)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-events-rejections-${process.pid}.sqlite`);
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

// The foreign-installation setup: an installation that belongs to another org
// (installations.id is a GLOBAL primary key, so an event can name it).
const seedForeignInstallation = async (ctx: any) => {
  await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
  await ctx.db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
     VALUES ('inst-foreign', 'org-b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'victim', 'Victim', 'victim@otherco.com')`,
  );
};

describe('hub /v1/events — per-event rejections (CGLAB-117)', () => {
  let app: any;
  let ctx: any;
  let token: string;

  const post = (events: any[], bearer: string = token) =>
    supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ events });

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app;
    ctx = out.ctx;
    token = await issueApiKey(ctx.db, 'org', 'test');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('reports reason "invalid" with the best-effort eventId when an event fails isValidEvent', async () => {
    const r = await post([sampleEvent({ eventId: 'bad-1', actor: null })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(1);
    expect(r.body.rejections).toEqual([
      { eventId: 'bad-1', reason: 'invalid' },
    ]);
  });

  it('reports eventId null for an invalid event that has no usable eventId', async () => {
    // No eventId at all, an empty-string eventId, or a degenerate array element
    // (null / number): all unusable, so the entry reports null. (Boundary:
    // keeps the length check from degenerating into `>= 0`, which would leak
    // '' into the deadletter key in story 2.)
    const r = await post([{ garbage: true }, sampleEvent({ eventId: '' }), null, 42]);
    expect(r.status).toBe(200);
    expect(r.body.rejected).toBe(4);
    expect(r.body.rejections).toEqual([
      { eventId: null, reason: 'invalid' },
      { eventId: null, reason: 'invalid' },
      { eventId: null, reason: 'invalid' },
      { eventId: null, reason: 'invalid' },
    ]);
  });

  it('reports reason "org_mismatch" for an event whose orgId is not the token org (the 31 Aug tenancy watermark)', async () => {
    const r = await post([sampleEvent({ eventId: 'org-x', orgId: 'someone-else' })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(1);
    expect(r.body.rejections).toEqual([
      { eventId: 'org-x', reason: 'org_mismatch' },
    ]);
    const countRow = await ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events');
    expect(countRow!.c).toBe(0);
  });

  it('reports reason "foreign_installation" when an unbound key names another org\'s installation', async () => {
    await seedForeignInstallation(ctx);
    const r = await post([sampleEvent({ eventId: 'foreign-1', installationId: 'inst-foreign' })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(1);
    expect(r.body.rejections).toEqual([
      { eventId: 'foreign-1', reason: 'foreign_installation' },
    ]);
    // The victim row must be untouched — the rejection is observed, not adopted.
    const row = await ctx.db.get<any>('SELECT org_id, os_user FROM installations WHERE id = ?', ['inst-foreign']);
    expect(row.org_id).toBe('org-b');
    expect(row.os_user).toBe('victim');
  });

  it('reports reason "foreign_installation" when a bound key names an installation that is not its own', async () => {
    const boundToken = await issueApiKey(ctx.db, 'org', 'bound', { installationId: 'inst-1' });
    const r = await post([sampleEvent({ eventId: 'not-mine', installationId: 'inst-2' })], boundToken);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(1);
    expect(r.body.rejections).toEqual([
      { eventId: 'not-mine', reason: 'foreign_installation' },
    ]);
  });

  it('reports reason "hidden_user" and still counts the drop in hiddenDropped, not rejected', async () => {
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@example.com']);
    const r = await post([sampleEvent({ eventId: 'hidden-1' })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(0);
    expect(r.body.hiddenDropped).toBe(1);
    expect(r.body.rejections).toEqual([
      { eventId: 'hidden-1', reason: 'hidden_user' },
    ]);
    const countRow = await ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events');
    expect(countRow!.c).toBe(0);
  });

  it('mixed batch: ingested + skipped + rejected + hidden all report in their legacy counters AND in rejections', async () => {
    await seedForeignInstallation(ctx);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@example.com']);
    const r = await post([
      // e-good-1 is bob, NOT alice: alice is hidden in this batch and the
      // default sampleEvent actor is alice, which would make the "good" event
      // a hidden_user drop too.
      sampleEvent({ eventId: 'e-good-1', actor: { osUser: 'bob', gitName: 'Bob', gitEmail: 'bob@example.com' } }), // ingested
      sampleEvent({ eventId: 'e-skip-1', type: 'tokens.logged' }),            // skipped
      sampleEvent({ eventId: 'e-bad-1', actor: null }),                       // invalid
      sampleEvent({ eventId: 'e-org-1', orgId: 'someone-else' }),             // org_mismatch
      sampleEvent({ eventId: 'e-foreign-1', installationId: 'inst-foreign' }),// foreign_installation
      sampleEvent({ eventId: 'e-hidden-1' }),                                 // hidden_user
    ]);
    expect(r.status).toBe(200);
    // Legacy counters: semantics unchanged.
    expect(r.body.ingested).toBe(1);
    expect(r.body.skipped).toBe(1);
    expect(r.body.rejected).toBe(3);
    expect(r.body.hiddenDropped).toBe(1);
    // The new payload: one entry per rejected/hidden event, with its reason.
    // Pinned in BATCH ORDER (the loop appends entries as it hits each event):
    // bad, org, foreign, hidden. Deliberate contract — a silent reorder would
    // break the flusher deadletter story's assumptions about response shape.
    expect(r.body.rejections).toEqual([
      { eventId: 'e-bad-1', reason: 'invalid' },
      { eventId: 'e-org-1', reason: 'org_mismatch' },
      { eventId: 'e-foreign-1', reason: 'foreign_installation' },
      { eventId: 'e-hidden-1', reason: 'hidden_user' },
    ]);
    // Only the good event reached the DB.
    const rows = await ctx.db.all<any>('SELECT event_id FROM events ORDER BY event_id');
    expect(rows.map((x: any) => x.event_id)).toEqual(['e-good-1']);
  });

  it('rejections is always present as an array, empty when nothing is rejected', async () => {
    const r = await post([sampleEvent({ eventId: 'clean-1' })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(r.body.rejections).toEqual([]);
  });

  it('early 4xx paths omit rejections (413 would be unbounded past the 500-event ceiling)', async () => {
    // Pin the DELIBERATE omission: the 413 cap fires before the loop and may
    // cover >500 events, so echoing rejections there would reopen the
    // response-size DoS the cap (bug 035a4736) exists to close. The flusher
    // treats 4xx as non-destructive (no outbox delete), so nothing depends on
    // the field's presence on these paths. A future "consistency" fix adding
    // it would silently reintroduce the unbounded response.
    const r400 = await post([]);
    expect(r400.status).toBe(400);
    expect(r400.body.rejections).toBeUndefined();
    const r413 = await post(Array.from({ length: 501 }, () => sampleEvent()));
    expect(r413.status).toBe(413);
    expect(r413.body.rejections).toBeUndefined();
  });

  it('a duplicate eventId in one batch is skipped (dedup), never a rejection', async () => {
    // INSERT OR IGNORE: the second copy is not a loss — the first was ingested.
    // Pinning this matters for the deadletter story: a duplicate must not be
    // reportable as a rejected (hence deadletterable) row.
    const r = await post([sampleEvent({ eventId: 'dup-1' }), sampleEvent({ eventId: 'dup-1' })]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(r.body.skipped).toBe(1);
    expect(r.body.rejected).toBe(0);
    expect(r.body.rejections).toEqual([]);
  });
});
