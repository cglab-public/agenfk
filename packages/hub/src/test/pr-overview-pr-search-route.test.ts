// GET /v1/prs/overview?pr=<number> — the route-level half of CGLAB-151.
//
// These are the PR-search route tests, and they boot the app on an IN-MEMORY
// sqlite database (`openSqliteDb(':memory:')` injected through createHubApp's
// `db` escape hatch) instead of the file-backed path queries.test.ts uses. Same
// engine, same SQL — the difference is that nothing is shared.
//
// The sharing is a real trap, recorded here because it cost this branch several
// wrong turns before the actual culprit (memory pressure) was found:
//
//   1. `openSqliteDb` uses `node:sqlite`'s **DatabaseSync** and turns on WAL for
//      any file-backed path (db/sqlite.ts). Synchronous driver: a blocked
//      statement parks the whole thread — no promise, no timeout, no error.
//   2. Hub tests key their DB file on `process.pid` (queries.test.ts and ~a dozen
//      others). But **worker threads share the parent's pid** — only `threadId`
//      differs (verified: main pid=22501 threadId=0, worker pid=22501
//      threadId=1). So every worker computes the SAME path.
//   3. Stryker's vitest runner **forces `pool: 'threads'`**
//      (@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js).
//
// So a file-backed hub spec on a threads pool does contend on one WAL database
// inside one process, and a sync driver turns that into a parked thread.
// `:memory:` is private per connection, so this spec cannot contend — which is
// why it is the one used for mutation sweeps. To be clear about causation: this
// hazard was NOT what stalled this branch. The OS was reaping Stryker's
// test-runner workers under memory pressure. Both are written up in
// vitest.cglab151hub.config.ts, along with the rule that came out of it — check
// swap and memory pressure before believing any hang.
//
// This is also why `npm test` has to run with file parallelism off. Fixing the
// pid-keyed paths repo-wide is a story of its own; this file just stops being
// part of the problem.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

const sample = (overrides: any = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: {},
  ...overrides,
});

describe('GET /v1/prs/overview — ?pr= search', () => {
  let app: any;
  let ctx: any;
  let db: HubDb;
  let cookie: string;

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({
      dbPath: ':memory:',
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
      db,
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';

    const token = await issueApiKey(ctx.db, 'org', 'test');
    const send = (events: any[]) =>
      supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });

    const pr = (over: any) => sample({
      type: 'pr.opened',
      remoteUrl: 'git@github.com:acme/api.git',
      ...over,
      payload: {
        prNumber: over.prNumber, repo: 'acme/api', model: over.model, harness: 'claude-code',
        sizing: over.sizing, sizingShadow: over.sizing, leafStory: over.leafStory ?? 0,
      },
    });

    await send([
      // alice: PR#1 opened small (1 task → 2pts → xs)
      pr({ eventId: 'p1', occurredAt: '2026-05-03T10:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 1, model: 'claude-opus-4-8', sizing: { epic: 0, story: 0, task: 1, bug: 0 } }),
      // alice: PR#2 opened then resized bigger (leafStory 1 + task 4 → 12pts → m)
      pr({ eventId: 'p2a', occurredAt: '2026-05-03T11:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 2, model: 'claude-opus-4-8', sizing: { epic: 0, story: 1, task: 1, bug: 0 }, leafStory: 1 }),
      pr({ eventId: 'p2b', type: 'pr.updated', occurredAt: '2026-05-04T09:00:00Z',
        actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
        prNumber: 2, model: 'claude-opus-4-8', sizing: { epic: 0, story: 1, task: 4, bug: 0 }, leafStory: 1 }),
      // bob: PR#3 (2 tasks → 4pts → s) via a different model
      pr({ eventId: 'p3', occurredAt: '2026-05-04T10:00:00Z',
        actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' },
        prNumber: 3, model: 'claude-sonnet-4-6', sizing: { epic: 0, story: 0, task: 2, bug: 0 } }),
    ]);
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await db.close();
  });

  const API_REMOTE = 'git@github.com:acme/api.git';

  it('finds a PR opened OUTSIDE the date window (date filter superseded)', async () => {
    // Without ?pr this window returns only bob's PR#3 (opened 05-04).
    const baseline = await supertest(app)
      .get('/v1/prs/overview?from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(baseline.body.totals.prs).toBe(1);

    const r = await supertest(app)
      .get('/v1/prs/overview?pr=1&from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(1);
  });

  it('finds a PR whose model the model filter excludes (model filter superseded)', async () => {
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=1&model=claude-sonnet-4-6').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].model).toBe('claude-opus-4-8');
  });

  it('finds a PR whose opener the developer filter excludes (developer filter superseded)', async () => {
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=1&users=bob@acme.com').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].user_key).toBe('alice@acme.com');
  });

  it('supersedes all of them at once', async () => {
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=1&from=2026-05-04T00:00:00Z&to=2026-05-05T00:00:00Z'
        + '&model=claude-sonnet-4-6&users=bob@acme.com')
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(1);
  });

  it('keeps the project filter — the one filter a PR search does not override', async () => {
    const mine = await supertest(app)
      .get(`/v1/prs/overview?pr=1&projects=${encodeURIComponent(API_REMOTE)}`).set('Cookie', cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.totals.prs).toBe(1);

    // Same number, different repo: the PR is not in that project, so nothing
    // is returned. Without this axis #1 would match every repo's first PR.
    const other = await supertest(app)
      .get(`/v1/prs/overview?pr=1&projects=${encodeURIComponent('git@github.com:acme/web.git')}`).set('Cookie', cookie);
    expect(other.status).toBe(200);
    expect(other.body.totals.prs).toBe(0);
  });

  it('accepts the # form people copy out of GitHub', async () => {
    // %23 is the encoded '#', which otherwise starts the URL fragment.
    const r = await supertest(app).get('/v1/prs/overview?pr=%232').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(2);
  });

  it('accepts a pasted PR URL', async () => {
    const url = encodeURIComponent('https://github.com/acme/api/pull/2/files');
    const r = await supertest(app).get(`/v1/prs/overview?pr=${url}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(2);
  });

  it('accepts a Bitbucket pull-request URL (the hub sizes PRs from any host)', async () => {
    const url = encodeURIComponent('https://bitbucket.org/acme/api/pull-requests/2/diff');
    const r = await supertest(app).get(`/v1/prs/overview?pr=${url}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(2);
  });

  it('cannot reach another org\'s PR — org scoping survives the search', async () => {
    // The search is the one path that reads the org's WHOLE PR event stream
    // with no time bound, which is exactly where a dropped `org_id = ?` would
    // show up: org-b would be handed org-a's PR numbers, repos, opener emails
    // and model names. If the number is ever pushed down into SQL (the obvious
    // optimisation), this is the test that has to keep passing.
    await ctx.db.run(`INSERT INTO orgs (id, name) VALUES ('org-b', 'org-b')`);
    await createPasswordUser(ctx.db, 'org-b', 'adminb@x', 'longenough1', 'admin');
    const loginB = await supertest(app).post('/auth/login').send({ email: 'adminb@x', password: 'longenough1' });
    const cookieB = loginB.headers['set-cookie']?.[0] ?? '';

    const here = await supertest(app).get('/v1/prs/overview?pr=1').set('Cookie', cookie);
    expect(here.body.totals.prs).toBe(1);

    const abroad = await supertest(app).get('/v1/prs/overview?pr=1').set('Cookie', cookieB);
    expect(abroad.status).toBe(200);
    expect(abroad.body.totals.prs).toBe(0);
    expect(abroad.body.prs).toEqual([]);
  });

  it('applies no search for a value that is not a PR number (never zero the page, never a 500)', async () => {
    for (const raw of ['abc', '0', '-1', '', '12a']) {
      const r = await supertest(app).get(`/v1/prs/overview?pr=${encodeURIComponent(raw)}`).set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(r.body.totals.prs).toBe(3);
    }
  });

  it('repeated ?pr= params are parsed, not a 500', async () => {
    const r = await supertest(app).get('/v1/prs/overview?pr=1&pr=2').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0].prNumber).toBe(1);
  });

  it('returns an empty result for a number that does not exist', async () => {
    const r = await supertest(app).get('/v1/prs/overview?pr=999').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(0);
    expect(r.body.prs).toEqual([]);
    expect(r.body.byDeveloper).toEqual([]);
  });

  it('lifts the SQL time bound so the LATEST sizing still wins', async () => {
    // PR#2 opened 05-03 at 6pts (s) and was re-sized on 05-04 to 12pts (m).
    // The window ends on 05-03, so pushing `to` into SQL would drop the
    // re-size event and report the stale size — the search must read the
    // whole event stream for that PR.
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=2&from=2026-05-03T00:00:00Z&to=2026-05-03T23:59:59Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.prs[0]).toMatchObject({ prNumber: 2, bucket: 'm', points: 12 });
    expect(r.body.byModel.find((m: any) => m.model === 'claude-opus-4-8').sizes)
      .toEqual({ xs: 0, s: 0, m: 1, l: 0, xl: 0 });
  });

  it('honours that same bound when there is NO search (the mirror of the test above)', async () => {
    // Without ?pr the bound IS honoured, so the re-size that happened after
    // `to` stays outside the window and PR#2 reports the size it had inside
    // it. This is the assertion that keeps the lift conditional: drop the
    // condition and the windowed overview would quietly start reporting sizes
    // struck after the window closed, while every existing windowed test kept
    // passing because none of them looked at a size.
    const r = await supertest(app)
      .get('/v1/prs/overview?from=2026-05-03T00:00:00Z&to=2026-05-03T23:59:59Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.prs.find((p: any) => p.prNumber === 2))
      .toMatchObject({ prNumber: 2, bucket: 's', points: 6 });
  });

  it('spans the open times of every PR the number matched, oldest first', async () => {
    // The same number in a second repo, opened later. period is min..max of
    // the matched PRs' open times; with one match both ends coincide, so only
    // a multi-repo search can tell an inverted comparison from a correct one.
    const token = await issueApiKey(ctx.db, 'org', 'second-repo');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
      events: [sample({
        eventId: 'p-web-1',
        type: 'pr.opened',
        occurredAt: '2027-01-15T10:00:00Z',
        remoteUrl: 'git@github.com:acme/web.git',
        actor: { osUser: 'dave', gitName: 'D', gitEmail: 'dave@acme.com' },
        payload: {
          prNumber: 1, repo: 'acme/web', model: 'glm-5.2', harness: 'claude-code',
          sizing: { epic: 0, story: 0, task: 3, bug: 0 },
          sizingShadow: { task: 3, bug: 0 }, leafStory: 0,
        },
      })],
    });

    const r = await supertest(app).get('/v1/prs/overview?pr=1').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.totals.prs).toBe(2);
    expect(r.body.period.from).toMatch(/^2026-05-03/);
    expect(r.body.period.to).toMatch(/^2027-01-15/);
  });

  it('reports the period the answer actually covers, not the requested window', async () => {
    // PR#2 opened 05-03; the request asked for a window starting 05-04.
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=2&from=2026-05-04T00:00:00Z&to=2026-05-10T00:00:00Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.period.from).toMatch(/^2026-05-03/);
    expect(r.body.period.to).toMatch(/^2026-05-03/);
  });

  it('reports no period when the search matched nothing', async () => {
    const r = await supertest(app).get('/v1/prs/overview?pr=999').set('Cookie', cookie);
    expect(r.body.period).toEqual({ from: null, to: null });
  });

  it('skips the previous-period delta — a comparison window is meaningless for one PR', async () => {
    const r = await supertest(app)
      .get('/v1/prs/overview?pr=1&from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.previous).toBeNull();
  });

  it('leaves the non-search behaviour untouched when ?pr is absent', async () => {
    const r = await supertest(app)
      .get('/v1/prs/overview?from=2026-05-04T00:00:00Z').set('Cookie', cookie);
    expect(r.body.totals.prs).toBe(1);
    expect(r.body.previous).not.toBeNull();
    expect(r.body.period.from).toBe('2026-05-04T00:00:00Z');
  });
});
