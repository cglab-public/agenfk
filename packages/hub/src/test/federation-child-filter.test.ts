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
    const enroll = async (name: string) => {
      const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
      expect(r.status).toBe(200);
      return r.body as { token: string; childHubId: string };
    };
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
    });

    it('still collapses a re-size from the SAME hub onto one PR', async () => {
      const r = await get(`/v1/prs/overview?childHubId=${alpha}`);
      expect(r.body.totals.prs).toBe(1);
      // alpha opened at 3 tasks and re-sized to 5 — latest sizing wins.
      expect(r.body.prs[0]).toMatchObject({ repo: 'acme/web', prNumber: 57, user_key: 'bob@acme.com' });
      expect(r.body.prs[0].points).toBe(10);
    });

    it('filters to this hub\'s own PRs with local', async () => {
      const r = await get('/v1/prs/overview?childHubId=local');
      expect(r.body.totals.prs).toBe(1);
      expect(r.body.prs[0]).toMatchObject({ user_key: 'alice@acme.com', points: 2 });
    });
  });
});
