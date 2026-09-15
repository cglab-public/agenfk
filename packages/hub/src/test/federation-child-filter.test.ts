// The childHubId facet on the query endpoints (CGLAB-184, task 3).
//
// A parent hub accumulates its own events AND every child's in one `events`
// table, told apart only by `child_hub_id` (NULL/'' for the parent's own rows,
// a child hub's UUID otherwise). Until now every query endpoint merged the lot,
// so a group of hubs could see a total but never ask "whose?".
//
// The contract these tests pin:
//   ?childHubId=local   -> this hub's own events only
//   ?childHubId=<uuid>  -> that child hub's events only
//   ?childHubId=a,b     -> the union of those two (CSV, like users/types)
//   (absent)            -> everything, which is all a standalone hub ever sees
// plus /v1/child-hubs, the facet that tells a picker which children actually
// carry data in the current window rather than every hub ever enrolled.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-childfilter-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

/** An outbox row as a child hub forwards it. */
const fwd = (childHubId: string, e: Record<string, unknown>) => ({
  id: `outbox-${e.eventId}`,
  kind: 'event',
  payload: {
    childHubId,
    identityPolicy: 'keep',
    event: {
      orgId: 'org', installationId: 'i1', occurredAt: '2026-05-03T10:00:00.000Z',
      itemType: 'TASK', payload: {}, ...e,
    },
  },
});

const prPayload = (repo: string, prNumber: number, task: number) => ({
  prNumber, repo, model: 'claude-opus-5', harness: 'claude-code',
  sizing: { epic: 0, story: 0, task, bug: 0 },
  sizingShadow: { task, bug: 0 }, leafStory: 0,
});

describe('childHubId facet on the query endpoints', () => {
  let app: any; let ctx: any; let cookie: string; let alpha: string; let beta: string;

  const get = (url: string) => supertest(app).get(url).set('Cookie', cookie);

  const enroll = async (name: string) => {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';

    // --- this hub's own events: alice, on acme/web ---
    const token = await issueApiKey(ctx.db, 'org', 'test');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
      events: [
        { eventId: 'l1', orgId: 'org', installationId: 'inst-local', occurredAt: '2026-05-03T08:00:00.000Z',
          actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
          type: 'item.created', itemType: 'TASK', remoteUrl: 'git@github.com:acme/web.git',
          projectId: 'p-local', itemId: 'i-l1', payload: {} },
        // The parent's own sizing of acme/web#57 — the same repo and number a
        // child also sizes below. Two different PRs on two different hubs.
        { eventId: 'l2', orgId: 'org', installationId: 'inst-local', occurredAt: '2026-05-03T09:00:00.000Z',
          actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
          type: 'pr.opened', remoteUrl: 'git@github.com:acme/web.git',
          payload: prPayload('acme/web', 57, 1) },
      ],
    });

    // --- child hub alpha: bob, on acme/api, plus his own acme/web#57 ---
    const a = await enroll('alpha');
    alpha = a.childHubId;
    const da = await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${a.token}`).send({
      rows: [
        fwd(alpha, { eventId: 'a1', userKey: 'bob@acme.com', type: 'item.closed',
          remoteUrl: 'git@github.com:acme/api.git', itemId: 'i-a1' }),
        fwd(alpha, { eventId: 'a2', userKey: 'bob@acme.com', type: 'pr.opened',
          occurredAt: '2026-05-03T11:00:00.000Z', remoteUrl: 'git@github.com:acme/web.git',
          payload: prPayload('acme/web', 57, 3) }),
        // A re-size of alpha's own PR: must still collapse onto it, not split.
        fwd(alpha, { eventId: 'a3', userKey: 'bob@acme.com', type: 'pr.updated',
          occurredAt: '2026-05-03T12:00:00.000Z', remoteUrl: 'git@github.com:acme/web.git',
          payload: prPayload('acme/web', 57, 5) }),
      ],
    });
    expect(da.status).toBe(200);

    // --- child hub beta: carol, on acme/infra, on a LATER day ---
    const b = await enroll('beta');
    beta = b.childHubId;
    const db2 = await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${b.token}`).send({
      rows: [
        fwd(beta, { eventId: 'b1', userKey: 'carol@acme.com', type: 'validate.passed',
          occurredAt: '2026-06-10T10:00:00.000Z', remoteUrl: 'git@github.com:acme/infra.git',
          itemId: 'i-b1', itemType: 'BUG' }),
      ],
    });
    expect(db2.status).toBe(200);
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  describe('/v1/users', () => {
    it('merges every hub when no childHubId is given', async () => {
      const r = await get('/v1/users');
      expect(r.status).toBe(200);
      expect(r.body.map((u: any) => u.user_key).sort()).toEqual(['alice@acme.com', 'bob@acme.com', 'carol@acme.com']);
    });

    it("'local' selects this hub's own events only", async () => {
      const r = await get('/v1/users?childHubId=local');
      expect(r.body.map((u: any) => u.user_key)).toEqual(['alice@acme.com']);
    });

    it('a child hub id selects only that child', async () => {
      const r = await get(`/v1/users?childHubId=${alpha}`);
      expect(r.body.map((u: any) => u.user_key)).toEqual(['bob@acme.com']);
    });

    it('keeps one child out of another — no cross-child leakage', async () => {
      const r = await get(`/v1/users?childHubId=${beta}`);
      expect(r.body.map((u: any) => u.user_key)).toEqual(['carol@acme.com']);
    });

    it('accepts a CSV of hubs and returns their union', async () => {
      const r = await get(`/v1/users?childHubId=local,${beta}`);
      expect(r.body.map((u: any) => u.user_key).sort()).toEqual(['alice@acme.com', 'carol@acme.com']);
    });

    it('an unknown child hub id matches nothing rather than everything', async () => {
      const r = await get('/v1/users?childHubId=00000000-0000-0000-0000-000000000000');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });

    it('never reaches across orgs, even given a real hub id from another one', async () => {
      // The id exists and has events; it just is not this caller's. The answer
      // must be indistinguishable from a garbage id — no existence oracle.
      await ctx.db.run(
        `INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?)`,
        ['foreign-hub', 'other-org', 'theirs', '2026-05-01', '2026-05-01'],
      );
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at,
                             received_at, type, payload, child_hub_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['foreign-1', 'other-org', 'i9', 'mallory@evil.com', '2026-05-03T10:00:00.000Z',
         '2026-05-03T10:00:00.000Z', 'item.created', '{}', 'foreign-hub'],
      );
      const r = await get('/v1/users?childHubId=foreign-hub');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });

    it('accepts the repeated-param spelling as well as the CSV one', async () => {
      const r = await get(`/v1/users?childHubId=local&childHubId=${beta}`);
      expect(r.body.map((u: any) => u.user_key).sort()).toEqual(['alice@acme.com', 'carol@acme.com']);
    });

    it('treats a present-but-empty childHubId as no filter, like every sibling filter', async () => {
      // Decided, not accidental: `parseList` drops empty values for users,
      // types and projects too, and a picker offering "All" must OMIT the param
      // rather than send it empty. Recorded on task fb34c72d.
      for (const q of ['', '%20', ',']) {
        const r = await get(`/v1/users?childHubId=${q}`);
        expect(r.status).toBe(200);
        expect(r.body.map((u: any) => u.user_key).sort())
          .toEqual(['alice@acme.com', 'bob@acme.com', 'carol@acme.com']);
      }
    });

    it('matches whatever case a hand-edited link uses — sentinel AND hub id', async () => {
      // Anything that upper-cases a URL upper-cases the UUID too, so normalising
      // only the sentinel would still leave the same silently-empty board.
      for (const spelling of ['local', 'LOCAL', 'Local']) {
        const r = await get(`/v1/users?childHubId=${spelling}`);
        expect(r.body.map((u: any) => u.user_key)).toEqual(['alice@acme.com']);
      }
      const upper = await get(`/v1/users?childHubId=${alpha.toUpperCase()}`);
      expect(upper.body.map((u: any) => u.user_key)).toEqual(['bob@acme.com']);
    });
  });

  describe('/v1/timeline', () => {
    it('returns only the selected hub\'s events', async () => {
      const r = await get(`/v1/timeline?childHubId=${alpha}`);
      expect(r.status).toBe(200);
      expect(r.body.events.map((e: any) => e.user_key)).toEqual(['bob@acme.com', 'bob@acme.com', 'bob@acme.com']);
      const local = await get('/v1/timeline?childHubId=local');
      expect(local.body.events.map((e: any) => e.event_id).sort()).toEqual(['l1', 'l2']);
    });
  });

  describe('/v1/metrics', () => {
    // Two code paths behind one endpoint: the rollups_daily path (default) and
    // the raw-events path (taken when projects/itemTypes is set). Both honour it.
    it('filters the rollups path', async () => {
      const r = await get('/v1/metrics?childHubId=local');
      expect(r.status).toBe(200);
      expect(r.body.series.map((s: any) => s.user_key)).toEqual(['alice@acme.com']);
      const a = await get(`/v1/metrics?childHubId=${alpha}`);
      expect(a.body.series.map((s: any) => s.user_key)).toEqual(['bob@acme.com']);
      expect(a.body.series.reduce((n: number, s: any) => n + s.events_count, 0)).toBe(3);
    });

    it('filters the raw-events path (projects filter set)', async () => {
      const r = await get(`/v1/metrics?projects=${encodeURIComponent('git@github.com:acme/web.git')}&childHubId=local`);
      expect(r.status).toBe(200);
      expect(r.body.series.map((s: any) => s.user_key)).toEqual(['alice@acme.com']);
      const a = await get(`/v1/metrics?projects=${encodeURIComponent('git@github.com:acme/web.git')}&childHubId=${alpha}`);
      expect(a.body.series.map((s: any) => s.user_key)).toEqual(['bob@acme.com']);
    });
  });

  describe('/v1/event-types', () => {
    it('lists only the types the selected hub reported', async () => {
      expect((await get('/v1/event-types?childHubId=local')).body.types.sort())
        .toEqual(['item.created', 'pr.opened']);
      expect((await get(`/v1/event-types?childHubId=${beta}`)).body.types)
        .toEqual(['validate.passed']);
    });
  });

  describe('/v1/projects', () => {
    it('lists only the repos the selected hub reported', async () => {
      expect((await get('/v1/projects?childHubId=local')).body.projects)
        .toEqual(['git@github.com:acme/web.git']);
      expect((await get(`/v1/projects?childHubId=${beta}`)).body.projects)
        .toEqual(['git@github.com:acme/infra.git']);
    });
  });

  describe('/v1/item-types', () => {
    it('scopes both the chip list and its counts to the selected hub', async () => {
      const r = await get(`/v1/item-types?childHubId=${beta}`);
      expect(r.status).toBe(200);
      expect(r.body.itemTypes).toEqual(['BUG']);
      expect(r.body.counts).toEqual({ BUG: 1 });
    });
  });

  describe('/v1/histogram', () => {
    it('counts only the selected hub\'s events', async () => {
      const r = await get(`/v1/histogram?bucket=day&childHubId=${alpha}`);
      expect(r.status).toBe(200);
      const sum = (body: any) => body.buckets.reduce((n: number, b: any) => n + b.total, 0);
      expect(sum(r.body)).toBe(3);
      const local = await get('/v1/histogram?bucket=day&childHubId=local');
      expect(sum(local.body)).toBe(2);
    });
  });

  describe('/v1/child-hubs', () => {
    it('lists the child hubs that carry data in the window, with their names', async () => {
      const r = await get('/v1/child-hubs');
      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.childHubs.map((c: any) => [c.id, c]));
      expect(Object.keys(byId).sort()).toEqual([alpha, beta].sort());
      expect(byId[alpha].name).toBe('alpha');
      expect(byId[alpha].events).toBe(3);
      expect(byId[beta].events).toBe(1);
    });

    it('reports whether this hub has events of its own, so a picker can offer "This hub"', async () => {
      expect((await get('/v1/child-hubs')).body.hasLocal).toBe(true);
    });

    it('honours the time window — a child with nothing in it is not offered', async () => {
      // beta's only event is 2026-06-10; this window ends before it.
      const r = await get('/v1/child-hubs?from=2026-05-01&to=2026-05-31');
      expect(r.body.childHubs.map((c: any) => c.id)).toEqual([alpha]);
    });

    it('keeps listing every option when one hub is already selected', async () => {
      // A picker that dropped the unselected hubs would strand the reader on
      // whichever one they picked first.
      const r = await get(`/v1/child-hubs?childHubId=${alpha}`);
      expect(r.body.childHubs.map((c: any) => c.id).sort()).toEqual([alpha, beta].sort());
      expect(r.body.hasLocal).toBe(true);
    });

    it('always offers the hub that is currently selected, window or not', async () => {
      // Narrowing the date range until the selected hub has nothing in it used
      // to drop it from its own picker: an empty board and no visible control
      // to leave it. The window still decides which OTHER hubs are offered.
      const r = await get(`/v1/child-hubs?from=2026-05-01&to=2026-05-31&childHubId=${beta}`);
      expect(r.status).toBe(200);
      const ids = r.body.childHubs.map((c: any) => c.id);
      expect(ids).toContain(beta);
      expect(ids).toContain(alpha);
      // Offered, but honestly: it contributes nothing to this window.
      expect(r.body.childHubs.find((c: any) => c.id === beta)).toMatchObject({ name: 'beta', events: 0 });
    });

    it('lists a hub once however many times the link names it', async () => {
      // parseList does not de-duplicate and the sentinel is case-normalised, so
      // a hand-edited or append-rather-than-toggle link can name one hub twice.
      // A doubled option is also a doubled React key in the picker.
      const r = await get(`/v1/child-hubs?from=2026-05-01&to=2026-05-31&childHubId=${beta},${beta.toUpperCase()}`);
      expect(r.status).toBe(200);
      expect(r.body.childHubs.filter((c: any) => c.id === beta)).toHaveLength(1);
    });

    it('keeps a detached hub listed, named, and flagged while its events remain', async () => {
      const d = await supertest(app).post(`/v1/admin/child-hubs/${alpha}/detach`)
        .set('Cookie', cookie).send({});
      expect(d.status).toBe(200);
      const r = await get('/v1/child-hubs');
      const row = r.body.childHubs.find((c: any) => c.id === alpha);
      // Its rows are still in `events` and still counted, so hiding it from the
      // picker would leave data nobody can select or explain.
      expect(row).toMatchObject({ name: 'alpha', detached: true, events: 3 });
    });

    it('ignores the other filters, exactly as the sibling facet lists do', async () => {
      // /event-types and /projects keep their chip lists org-wide so a selection
      // can never remove its own chip. The hub picker needs the same guarantee
      // for a different reason: narrowing by a local-only developer would empty
      // the picker and strand the reader on this hub with no control to leave.
      const r = await get('/v1/child-hubs?users=alice%40acme.com');
      expect(r.status).toBe(200);
      expect(r.body.childHubs.map((c: any) => c.id).sort()).toEqual([alpha, beta].sort());
      const byType = await get('/v1/child-hubs?types=item.created');
      expect(byType.body.childHubs.map((c: any) => c.id).sort()).toEqual([alpha, beta].sort());
    });

    it('lists only this org\'s child hubs, even when the foreign one has events', async () => {
      // A hub with no events is unlistable whatever the org scoping does — the
      // list is built from the events grouping — so seeding events is what makes
      // this a test of the boundary rather than of the join.
      await ctx.db.run(
        `INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?)`,
        ['other-org-hub', 'other-org', 'intruder', '2026-05-01', '2026-05-01'],
      );
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at,
                             received_at, type, payload, child_hub_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['other-org-1', 'other-org', 'i9', 'mallory@evil.com', '2026-05-03T10:00:00.000Z',
         '2026-05-03T10:00:00.000Z', 'item.created', '{}', 'other-org-hub'],
      );
      const r = await get('/v1/child-hubs');
      expect(r.body.childHubs.map((c: any) => c.id)).not.toContain('other-org-hub');
      expect(r.body.childHubs.map((c: any) => c.id).sort()).toEqual([alpha, beta].sort());
    });

    it('offers no children on a hub that has none, and still reports local', async () => {
      const soloDb = DB.replace('.sqlite', '-solo.sqlite');
      const solo = await createHubApp({ dbPath: soloDb, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
      try {
        await createPasswordUser(solo.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
        const c = (await supertest(solo.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
        const r = await supertest(solo.app).get('/v1/child-hubs').set('Cookie', c);
        expect(r.status).toBe(200);
        expect(r.body.childHubs).toEqual([]);
        expect(r.body.hasLocal).toBe(false);
      } finally {
        solo.ctx.stopWorkers?.(); await drainApp(solo.app); await solo.ctx.db.close();
        for (const s of ['', '-wal', '-shm']) { const f = soloDb + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
      }
    });
  });

  describe('/v1/prs/overview', () => {
    it('keeps two hubs\' same-numbered PRs apart instead of collapsing them', async () => {
      // acme/web#57 exists on this hub (alice, 1 task) AND on alpha (bob,
      // re-sized to 5 tasks). Keyed on (repo, prNumber) alone these merge into
      // one PR whose size and opener depend on arrival order.
      const r = await get('/v1/prs/overview');
      expect(r.status).toBe(200);
      expect(r.body.totals.prs).toBe(2);
      expect(r.body.prs.map((p: any) => p.user_key).sort()).toEqual(['alice@acme.com', 'bob@acme.com']);
      // The field a picker filters on must actually come back, or the UI cannot
      // tell the two otherwise-identical rows apart.
      expect(r.body.prs.map((p: any) => p.childHubId).sort()).toEqual([alpha, 'local'].sort());
    });

    it('still collapses a re-size from the SAME hub onto one PR', async () => {
      const r = await get(`/v1/prs/overview?childHubId=${alpha}`);
      expect(r.body.totals.prs).toBe(1);
      // alpha opened at 3 tasks and re-sized to 5 — latest sizing wins.
      expect(r.body.prs[0]).toMatchObject({ repo: 'acme/web', prNumber: 57, user_key: 'bob@acme.com', childHubId: alpha });
      expect(r.body.prs[0].points).toBe(10);
    });

    it('carries the filter into the previous-window comparison too', async () => {
      // A delta computed over the whole federation while the current window
      // shows one hub is a number nobody asked for. Needs data BEFORE `from`,
      // or the comparison is zero either way and the assertion proves nothing.
      const a = await enroll('gamma');
      await supertest(app).post('/v1/federation/deliver')
        .set('Authorization', `Bearer ${a.token}`).send({
          rows: [fwd(a.childHubId, { eventId: 'g1', userKey: 'dan@acme.com', type: 'pr.opened',
            occurredAt: '2026-05-01T10:00:00.000Z', remoteUrl: 'git@github.com:acme/old.git',
            payload: prPayload('acme/old', 9, 1) })],
        });
      const token = await issueApiKey(ctx.db, 'org', 'prev');
      await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
        events: [{ eventId: 'l-prev', orgId: 'org', installationId: 'inst-local',
          occurredAt: '2026-05-01T11:00:00.000Z',
          actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
          type: 'pr.opened', remoteUrl: 'git@github.com:acme/web.git',
          payload: prPayload('acme/web', 8, 1) }],
      });

      const window = 'from=2026-05-02T00:00:00.000Z&to=2026-05-04T00:00:00.000Z';
      // Both hubs opened one PR in the previous window.
      expect((await get(`/v1/prs/overview?${window}`)).body.previous.prs).toBe(2);
      // Filtered, the comparison must count only the selected hub's.
      expect((await get(`/v1/prs/overview?${window}&childHubId=local`)).body.previous.prs).toBe(1);
      expect((await get(`/v1/prs/overview?${window}&childHubId=${a.childHubId}`)).body.previous.prs).toBe(1);
      expect((await get(`/v1/prs/overview?${window}&childHubId=${beta}`)).body.previous.prs).toBe(0);
    });

    it('filters to this hub\'s own PRs with local', async () => {
      const r = await get('/v1/prs/overview?childHubId=local');
      expect(r.body.totals.prs).toBe(1);
      expect(r.body.prs[0]).toMatchObject({ user_key: 'alice@acme.com', points: 2, childHubId: 'local' });
    });
  });
});
