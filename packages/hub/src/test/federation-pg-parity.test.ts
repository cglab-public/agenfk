// Dual-backend parity for hub federation (CGLAB-181): the same enrollment
// scenario as federation-enroll.test.ts, run on the pg-mem backend so the new
// DDL and every runtime statement pass through the dialect translator.
import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { writeParentBinding } from '../services/federation/parentBinding';
import { enqueueOutbox, outboxDepth, federationTick } from '../services/federation/federationSync';
import { applyUpgradeDispatch } from '../services/federation/upgradeFanout';
import { applyUpgradeCancel } from '../services/federation/upgradeCancel';
import { reportUpgradeProgress } from '../services/federation/upgradeProgress';
import { releaseParentFlows } from '../services/federation/parentFlows';
import { recomputeRollups } from '../rollup';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

async function bootHubOnPg(
  extra: Record<string, unknown> = {},
): Promise<{ app: any; db: HubDb; cookie: string }> {
  const db = await openPgMemDb();
  const out = await createHubApp({
    dbPath: '/tmp/unused-federation-pg-parity.sqlite',
    secretKey: SECRET,
    sessionSecret: 'sess-secret',
    defaultOrgId: 'org',
    db,
    ...extra,
  } as any);
  await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
  const login = await supertest(out.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
  return { app: out.app, db, cookie: login.headers['set-cookie']?.[0] ?? '' };
}

describe('PG parity: hub federation enrollment (CGLAB-181)', () => {
  it('boots with child_hubs + federation_keys and runs invite → enroll → ping → directives', async () => {
    const { app, db, cookie } = await bootHubOnPg();

    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    expect(inv.status).toBe(200);

    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child', hubVersion: '1.1.19' },
    });
    expect(enr.status).toBe(200);
    expect(enr.body.token).toMatch(/^fed_/);

    const row = await db.get<any>('SELECT * FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(row.name).toBe('pg-child');
    expect(row.detached_at).toBeNull();

    const ping = await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ hubVersion: '1.2.0' });
    expect(ping.status).toBe(200);
    const after = await db.get<any>('SELECT hub_version FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(after.hub_version).toBe('1.2.0');

    // A malformed version sends NULL into COALESCE(?, hub_version). That
    // untyped-parameter shape is exactly what the dialect translator has to
    // get right, and the SQLite test alone never exercises it here.
    const junk = await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ hubVersion: 'not-a-version' });
    expect(junk.status).toBe(200);
    const kept = await db.get<any>('SELECT hub_version FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(kept.hub_version).toBe('1.2.0');

    const dir = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${enr.body.token}`);
    expect(dir.status).toBe(204);

    // single-use invite on PG too
    const again = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name: 'x' } });
    expect(again.status).toBe(400);

    // principal separation on PG
    const inst = await issueApiKey(db, 'org', 'inst');
    expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${inst}`).send({})).status).toBe(401);
    expect((await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${enr.body.token}`)).status).toBe(401);

    await db.close();
  });

  it('dispatches a flow to child hubs on Postgres, including a hub that enrolls later', async () => {
    // The dispatch tables and the directive query are new DDL plus a LEFT JOIN
    // with a three-way state predicate — exactly the shape the dialect
    // translator has to carry, and the SQLite tests alone never exercise it.
    const { app, db, cookie } = await bootHubOnPg();

    const made = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie).send({
      definition: {
        name: 'PG Group Flow',
        steps: [{ id: 'todo', name: 'TODO', order: 0 }, { id: 'done', name: 'DONE', order: 1 }],
      },
    });
    expect(made.status).toBe(201);

    const d = await supertest(app).post('/v1/admin/flow-dispatches').set('Cookie', cookie)
      .send({ flowId: made.body.id, scope: 'all' });
    expect(d.status).toBe(200);

    // Enrolled AFTER the dispatch: scope 'all' has to reach it.
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-late' } });
    expect(enr.status).toBe(200);

    const poll = await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${enr.body.token}`);
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ kind: 'flow.dispatch' });
    expect(poll.body.flow.definition.steps.map((s: any) => s.name)).toEqual(['TODO', 'DONE']);

    // Serving is not landing: the target exists and is still pending.
    const list = await supertest(app).get('/v1/admin/flow-dispatches').set('Cookie', cookie);
    expect(list.body.dispatches[0].targets).toHaveLength(1);
    expect(list.body.dispatches[0].targets[0].state).toBe('pending');

    // And a cancelled dispatch stops being served.
    await supertest(app).post(`/v1/admin/flow-dispatches/${d.body.id}/cancel`).set('Cookie', cookie).send({});
    const after = await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${enr.body.token}`);
    expect(after.status).toBe(204);

    await db.close();
  });
});

describe("PG parity: a 'selected' dispatch (701c4ca4)", () => {
  // Both parity tests above dispatch with scope 'all', so the target-validation
  // IN list and the INSERT ... SELECT that writes a target row had never been
  // through the dialect translator at all — the two statements this fix added.
  it('validates and writes selected targets on Postgres, for both dispatch kinds', async () => {
    const { app, db, cookie } = await bootHubOnPg({
      releaseExists: async (v: string) => v === '1.2.3',
    });

    const enroll = async (name: string) => {
      const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/v1/federation/enroll')
        .send({ inviteToken: inv.body.inviteToken, childHub: { name } });
      expect(r.status).toBe(200);
      return r.body as { token: string; childHubId: string };
    };
    const a = await enroll('pg-alpha');
    const b = await enroll('pg-beta');

    const made = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie).send({
      definition: { name: 'PG Selected', steps: [{ id: 'todo', name: 'TODO', order: 0 }] },
    });
    expect(made.status).toBe(201);

    // The refusal path: the IN list must resolve on PG, and name what it could
    // not target.
    const bad = await supertest(app).post('/v1/admin/flow-dispatches').set('Cookie', cookie)
      .send({ flowId: made.body.id, scope: 'selected', childHubIds: [a.childHubId, 'no-such-hub'] });
    expect(bad.status).toBe(404);
    expect(bad.body.missing).toEqual(['no-such-hub']);

    // The write path: INSERT ... SELECT with the detached_at guard in the
    // statement.
    const ok = await supertest(app).post('/v1/admin/flow-dispatches').set('Cookie', cookie)
      .send({ flowId: made.body.id, scope: 'selected', childHubIds: [a.childHubId, a.childHubId] });
    expect(ok.status).toBe(200);
    const targets = await db.all<any>(
      'SELECT child_hub_id FROM flow_dispatch_targets WHERE dispatch_id = ?', [ok.body.id],
    );
    expect(targets.map(t => t.child_hub_id)).toEqual([a.childHubId]);

    // Only the named hub is served it.
    const served = await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${b.token}`);
    expect(served.status).toBe(204);

    // And the upgrade twin, which shares both statements.
    const up = await supertest(app).post('/v1/admin/upgrade-dispatches').set('Cookie', cookie)
      .send({ targetVersion: '1.2.3', scope: 'selected', childHubIds: [b.childHubId] });
    expect(up.status).toBe(200);
    const upTargets = await db.all<any>(
      'SELECT child_hub_id FROM upgrade_dispatch_targets WHERE dispatch_id = ?', [up.body.id],
    );
    expect(upTargets.map(t => t.child_hub_id)).toEqual([b.childHubId]);

    await db.close();
  });
});

describe('PG parity: child-hub administration (CGLAB-181)', () => {
  it('lists, renames and detaches a child hub, with Date-shaped timestamps normalised', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child', hubVersion: '1.1.19' },
    });
    expect(enr.status).toBe(200);

    // Postgres hands back Date objects where SQLite hands back strings, and
    // the list both serialises those and derives `live` from them — the one
    // place this route can differ between backends.
    const list = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.isParent).toBe(true);
    expect(list.body.childHubs).toHaveLength(1);
    const row = list.body.childHubs[0];
    expect(row).toMatchObject({ name: 'pg-child', hubVersion: '1.1.19', detached: false, live: true });
    expect(typeof row.lastSeen).toBe('string');
    expect(new Date(row.lastSeen).toISOString()).toBe(row.lastSeen);
    expect(JSON.stringify(list.body)).not.toMatch(/fed_/);

    const renamed = await supertest(app).put(`/v1/admin/child-hubs/${enr.body.childHubId}`)
      .set('Cookie', cookie).send({ name: '  pg-renamed  ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('pg-renamed');

    const det = await supertest(app).post(`/v1/admin/child-hubs/${enr.body.childHubId}/detach`)
      .set('Cookie', cookie).send({});
    expect(det.status).toBe(200);
    expect(det.body.revokedKeys).toBe(1);
    expect(typeof det.body.detachedAt).toBe('string');

    // enforcement reaches the child on PG too
    expect((await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({})).status).toBe(401);

    // detached is hidden by default, visible and flagged on request
    expect((await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie)).body.childHubs).toEqual([]);
    const all = await supertest(app).get('/v1/admin/child-hubs?includeDetached=1').set('Cookie', cookie);
    expect(all.body.childHubs[0]).toMatchObject({ detached: true, live: false });
    expect(all.body.isParent).toBe(true);

    // re-detaching is idempotent on PG as well
    const again = await supertest(app).post(`/v1/admin/child-hubs/${enr.body.childHubId}/detach`)
      .set('Cookie', cookie).send({});
    expect(again.body.revokedKeys).toBe(0);
    expect(again.body.detachedAt).toBe(det.body.detachedAt);

    await db.close();
  });
});

describe('PG parity: child-side federation outbox (CGLAB-181)', () => {
  it('queues, orders, retries and drains on Postgres', async () => {
    const db = await openPgMemDb();
    const SEC = 'a'.repeat(64);
    await writeParentBinding(db, SEC, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });

    // BIGSERIAL rather than MAX(seq)+1 is the whole point: two connections in
    // the pool would otherwise read the same maximum and collide.
    for (const n of [1, 2, 3]) expect(await enqueueOutbox(db, 'event', { n })).toBe(true);
    expect(await outboxDepth(db)).toBe(3);

    const seen: any[] = [];
    const failing = {
      ping: async () => ({ ok: true }),
      directives: async () => null,
      deliver: async () => { throw Object.assign(new Error('nope'), { response: { status: 503 } }); },
    };
    const retried = await federationTick({ db, secretKey: SEC, transport: failing as any });
    expect(retried.ok).toBe(false);
    expect(await outboxDepth(db)).toBe(3);
    // ISO string into TIMESTAMPTZ, then compared with <= on the way back out
    const row = await db.get<any>('SELECT attempts, next_attempt_at FROM federation_outbox ORDER BY seq ASC');
    expect(Number(row.attempts)).toBe(1);

    const notYet = await federationTick({ db, secretKey: SEC, transport: { ...failing, deliver: async (r: any[]) => { seen.push(...r); return {}; } } as any });
    expect(notYet.delivered).toBe(0);
    expect(seen).toHaveLength(0);

    await db.run("UPDATE federation_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    const drained = await federationTick({
      db, secretKey: SEC,
      transport: { ...failing, deliver: async (r: any[]) => { seen.push(...r); return {}; } } as any,
    });
    expect(drained.delivered).toBe(3);
    expect(seen.map((r: any) => r.payload.n)).toEqual([1, 2, 3]);
    expect(await outboxDepth(db)).toBe(0);

    await db.close();
  });
});

describe('PG parity: release requests (CGLAB-181)', () => {
  it('records a request, keeps the original timestamp, and surfaces it on the roster', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child' },
    });
    expect(enr.status).toBe(200);

    // An untyped NULL into release_reason TEXT and an ISO string into
    // COALESCE(release_requested_at, $1) against TIMESTAMPTZ — exactly the
    // parameter shapes this file exists to catch.
    const first = await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({});
    expect(first.status).toBe(200);

    const MARKER = '2020-01-01T00:00:00.000Z';
    await db.run('UPDATE child_hubs SET release_requested_at = ? WHERE id = ?', [MARKER, enr.body.childHubId]);
    const second = await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ reason: 'splitting off' });
    expect(second.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    const row = list.body.childHubs[0];
    expect(row).toMatchObject({ releaseRequested: true, releaseReason: 'splitting off' });
    // Date-shaped on real pg, string on pg-mem; the DTO must emit one shape
    expect(new Date(row.releaseRequestedAt).toISOString()).toBe(MARKER);

    // re-asking with no reason must not erase the sentence the admin is reading
    await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({});
    const after = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    expect(after.body.childHubs[0].releaseReason).toBe('splitting off');

    await db.close();
  });
});

describe('PG parity: parent-side ingest of forwarded events (CGLAB-184)', () => {
  it('stores, deduplicates and rolls up per child hub on Postgres', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const enrol = async (name: string) => {
      const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
      expect(r.status).toBe(200);
      return r.body as { token: string; childHubId: string };
    };
    const row = (id: string) => ({
      id: `outbox-${id}`, kind: 'event',
      payload: { identityPolicy: 'keep', event: {
        eventId: id, orgId: 'org', installationId: 'i1', userKey: 'alice@acme.com',
        occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed', itemId: `item-${id}`, payload: {},
      } },
    });

    const a = await enrol('pg-alpha');
    const b = await enrol('pg-beta');
    const deliver = (token: string, rows: unknown[]) =>
      supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({ rows });

    expect((await deliver(a.token, [row('e1'), row('e2')])).body).toMatchObject({ accepted: 2, duplicates: 0 });
    // at-least-once delivery means this WILL happen in production
    expect((await deliver(a.token, [row('e1'), row('e2')])).body).toMatchObject({ accepted: 0, duplicates: 2 });
    // the same ids from another child are a different series, not a collision
    expect((await deliver(b.token, [row('e1')])).body).toMatchObject({ accepted: 1 });

    // The rollup's new PRIMARY KEY column and its GROUP BY, on the backend
    // where the key had to be swapped in place rather than rebuilt.
    await recomputeRollups(db, { full: true });
    const rolled = await db.all<any>(
      "SELECT child_hub_id, events_count FROM rollups_daily WHERE child_hub_id <> '' ORDER BY events_count DESC",
    );
    expect(rolled).toHaveLength(2);
    expect(Number(rolled[0].events_count)).toBe(2);
    expect(Number(rolled[1].events_count)).toBe(1);

    // --- the childHubId query facet (CGLAB-184, task 3) on Postgres ---
    //
    // The filter is the one place the two backends can silently disagree.
    // `child_hub_id` is NULLable on events and NOT NULL DEFAULT '' on
    // rollups_daily, so the two tables get different SQL for the same question —
    // COALESCE(child_hub_id,'') on events, the plain column on rollups_daily —
    // and the dialect translator has to carry both through, alongside an IN list.
    const token = await issueApiKey(db, 'org', 'pg-local');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
      events: [{
        eventId: 'pg-local-1', orgId: 'org', installationId: 'inst-local',
        occurredAt: '2026-09-14T08:00:00.000Z',
        actor: { osUser: 'zoe', gitName: 'Z', gitEmail: 'zoe@acme.com' },
        type: 'item.created', itemType: 'TASK', itemId: 'i-pg-1',
        remoteUrl: 'git@github.com:acme/pg.git', payload: {},
      }],
    });
    await recomputeRollups(db, { full: true });

    const q = (url: string) => supertest(app).get(url).set('Cookie', cookie);

    const localUsers = await q('/v1/users?childHubId=local');
    expect(localUsers.status).toBe(200);
    expect(localUsers.body.map((u: any) => u.user_key)).toEqual(['zoe@acme.com']);

    const alphaUsers = await q(`/v1/users?childHubId=${a.childHubId}`);
    expect(alphaUsers.body.map((u: any) => u.user_key)).toEqual(['alice@acme.com']);

    // The rollups path, where the column is NOT NULL DEFAULT '' and the
    // predicate is therefore the plain column. Both spellings of the selection:
    // the sentinel, and an actual child hub id — the IN-list form had no
    // Postgres assertion at all, which is the half that regressed once.
    const localMetrics = await q('/v1/metrics?childHubId=local');
    expect(localMetrics.status).toBe(200);
    expect(localMetrics.body.series.map((s: any) => s.user_key)).toEqual(['zoe@acme.com']);

    const childMetrics = await q(`/v1/metrics?childHubId=${a.childHubId}`);
    expect(childMetrics.status).toBe(200);
    expect(childMetrics.body.series.map((s: any) => s.user_key)).toEqual(['alice@acme.com']);
    expect(childMetrics.body.series.reduce((n: number, s: any) => n + s.events_count, 0)).toBe(2);

    const bothMetrics = await q(`/v1/metrics?childHubId=local,${a.childHubId}`);
    expect(bothMetrics.body.series.map((s: any) => s.user_key).sort())
      .toEqual(['alice@acme.com', 'zoe@acme.com']);

    const facet = await q('/v1/child-hubs');
    expect(facet.status).toBe(200);
    expect(facet.body.childHubs.map((c: any) => c.id).sort())
      .toEqual([a.childHubId, b.childHubId].sort());
    expect(facet.body.childHubs.every((c: any) => typeof c.events === 'number')).toBe(true);
    expect(facet.body.hasLocal).toBe(true);

    await db.close();
  });
});

describe('PG parity: dispatch reports moving a target (CGLAB-182)', () => {
  it('transitions flow_dispatch_targets on the child\'s report, on Postgres', async () => {
    // The ingest's UPDATE carries a subquery (`dispatch_id IN (SELECT id FROM
    // flow_dispatches WHERE org_id = ?)`) and a state guard in the WHERE. That
    // shape is exactly where the two backends have disagreed before, and the
    // SQLite suite cannot see it.
    const { app, db, cookie } = await bootHubOnPg();

    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enrolled = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child' } });
    expect(enrolled.status).toBe(200);
    const { token, childHubId } = enrolled.body as { token: string; childHubId: string };

    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['pg-flow', 'org', 'Group TDD',
       JSON.stringify({ name: 'Group TDD', steps: [{ id: 's0', name: 'TODO', order: 0 }] })],
    );
    await db.run(
      `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
       VALUES (?, ?, ?, 1, 'all', ?)`,
      ['pg-d1', 'org', 'pg-flow', new Date().toISOString()],
    );

    // Served, so a target row exists — and serving must leave it pending.
    const served = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);
    expect(served.status).toBe(200);
    const pending = await db.get<any>(
      'SELECT state FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['pg-d1', childHubId],
    );
    expect(pending.state).toBe('pending');

    const report = (eventId: string, type: string, detail: string | null) =>
      supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
        rows: [{ id: `ob-${eventId}`, kind: 'event', payload: { event: {
          eventId, type, occurredAt: new Date().toISOString(), userKey: 'system',
          payload: { dispatchId: 'pg-d1', detail },
        } } }],
      });

    expect((await report('pg-r1', 'fleet:flow-dispatch:installed', null)).status).toBe(200);
    const after = await db.get<any>(
      'SELECT state, detail FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['pg-d1', childHubId],
    );
    expect(after.state).toBe('installed');

    // The no-regression guard, on the backend where the WHERE clause is
    // translated rather than executed verbatim.
    await report('pg-r2', 'fleet:flow-dispatch:failed', 'stale');
    const guarded = await db.get<any>(
      'SELECT state, detail FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['pg-d1', childHubId],
    );
    expect(guarded.state).toBe('installed');
    expect(guarded.detail).toBeNull();

    // The org subquery in its NEGATIVE direction: a target row that matches on
    // both key columns, under a dispatch belonging to another org, must not
    // move. Asserting only the positive direction proves the statement runs,
    // not that it filters.
    await db.run("INSERT INTO orgs (id, name) VALUES (?, ?)", ['org-pg-b', 'org-pg-b']);
    await db.run(
      `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
       VALUES (?, ?, ?, 1, 'all', ?)`,
      ['pg-d-other', 'org-pg-b', 'pg-flow', new Date().toISOString()],
    );
    await db.run(
      `INSERT INTO flow_dispatch_targets (dispatch_id, child_hub_id, state, updated_at)
       VALUES (?, ?, 'pending', ?)`,
      ['pg-d-other', childHubId, new Date().toISOString()],
    );
    await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
      rows: [{ id: 'ob-pg-x', kind: 'event', payload: { event: {
        eventId: 'pg-r3', type: 'fleet:flow-dispatch:installed',
        occurredAt: new Date().toISOString(), userKey: 'system',
        payload: { dispatchId: 'pg-d-other' },
      } } }],
    });
    const other = await db.get<any>(
      'SELECT state FROM flow_dispatch_targets WHERE dispatch_id = ?', ['pg-d-other'],
    );
    expect(other.state).toBe('pending');
  });

  it('lets installed correct an earlier failed, on Postgres', async () => {
    // The monotonic guard builds its IN list per event type, so the two types
    // produce DIFFERENT SQL. Both shapes have to survive the translator.
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enrolled = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child-2' } });
    const { token, childHubId } = enrolled.body as { token: string; childHubId: string };

    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['pg-flow2', 'org', 'F', JSON.stringify({ name: 'F', steps: [{ id: 's0', name: 'T', order: 0 }] })],
    );
    await db.run(
      `INSERT INTO flow_dispatches (id, org_id, flow_id, flow_version, scope_type, created_at)
       VALUES (?, ?, ?, 1, 'all', ?)`,
      ['pg-d2', 'org', 'pg-flow2', new Date().toISOString()],
    );
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);

    const send = (eventId: string, type: string, detail: string | null) =>
      supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
        rows: [{ id: `ob-${eventId}`, kind: 'event', payload: { event: {
          eventId, type, occurredAt: new Date().toISOString(), userKey: 'system',
          payload: { dispatchId: 'pg-d2', detail },
        } } }],
      });

    await send('pg-f1', 'fleet:flow-dispatch:failed', 'transient');
    expect((await db.get<any>(
      'SELECT state FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['pg-d2', childHubId])).state).toBe('failed');

    await send('pg-i1', 'fleet:flow-dispatch:installed', null);
    const t = await db.get<any>(
      'SELECT state, detail FROM flow_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      ['pg-d2', childHubId]);
    expect(t.state).toBe('installed');
    expect(t.detail).toBeNull();
  });
});

describe('PG parity: group upgrade dispatch (CGLAB-183)', () => {
  const bootWithReleases = () => bootHubOnPg({ releaseExists: async (v: string) => v === '1.2.3' });

  it('creates, serves and cancels an upgrade dispatch on Postgres', async () => {
    // Two things only this backend can catch. `confirm_downgrade` is BOOLEAN
    // here and INTEGER on SQLite, so a truthiness check that works on one can
    // read wrong on the other. And created_at is a Date here but an ISO string
    // on SQLite, which is what the feed's oldest-first comparison sorts on.
    const { app, db, cookie } = await bootWithReleases();

    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enrolled = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-up' } });
    expect(enrolled.status).toBe(200);
    const { token, childHubId } = enrolled.body as { token: string; childHubId: string };

    const created = await supertest(app).post('/v1/admin/upgrade-dispatches')
      .set('Cookie', cookie).send({ targetVersion: '1.2.3', scope: 'all', confirmDowngrade: true });
    expect(created.status).toBe(200);

    const served = await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${token}`);
    expect(served.status).toBe(200);
    expect(served.body.kind).toBe('upgrade.dispatch');
    expect(served.body.targetVersion).toBe('1.2.3');
    // The BOOLEAN/INTEGER divergence, asserted as a real boolean.
    expect(served.body.confirmDowngrade).toBe(true);

    // Serving is not landing, on this backend too.
    const t = await db.get<any>(
      'SELECT state FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      [created.body.id, childHubId],
    );
    expect(t.state).toBe('pending');

    const listed = await supertest(app).get('/v1/admin/upgrade-dispatches').set('Cookie', cookie);
    expect(listed.status).toBe(200);
    const row = listed.body.dispatches.find((d: any) => d.id === created.body.id);
    expect(row.confirmDowngrade).toBe(true);
    expect(row.targets).toHaveLength(1);
    expect(row.targets[0].state).toBe('pending');

    const cancelled = await supertest(app)
      .post(`/v1/admin/upgrade-dispatches/${created.body.id}/cancel`).set('Cookie', cookie);
    expect(cancelled.status).toBe(200);

    // This hub was already served the dispatch, so cancelling it does not go
    // quiet — it hands the hub an upgrade.cancel to stop what it started
    // (CGLAB-183 task 4), and the target says it has been ASKED rather than
    // claiming it stopped.
    const afterCancel = await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${token}`);
    expect(afterCancel.status).toBe(200);
    expect(afterCancel.body.kind).toBe('upgrade.cancel');
    expect((await db.get<any>(
      'SELECT state FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      [created.body.id, childHubId])).state).toBe('cancel-pending');
  });

  it('picks the older of the two directive kinds on Postgres, where created_at is a Date', async () => {
    // Both kinds must EXIST or the comparison short-circuits on `!row` and the
    // test proves nothing. The upgrade is issued first, so it must be served
    // first even though the flow dispatch is the one the older code path
    // looked at.
    const { app, db, cookie } = await bootWithReleases();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const { token } = (await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-order' } })).body;

    const upgrade = await supertest(app).post('/v1/admin/upgrade-dispatches')
      .set('Cookie', cookie).send({ targetVersion: '1.2.3', scope: 'all' });
    expect(upgrade.status).toBe(200);
    // Push it into the past so the two created_at values cannot tie on a fast
    // machine — a tie would make the assertion depend on evaluation order.
    await db.run('UPDATE upgrade_dispatches SET created_at = ? WHERE id = ?',
      [new Date(Date.now() - 60_000).toISOString(), upgrade.body.id]);

    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['pg-of', 'org', 'F', JSON.stringify({ name: 'F', steps: [{ id: 's0', name: 'T', order: 0 }] })],
    );
    const flow = await supertest(app).post('/v1/admin/flow-dispatches')
      .set('Cookie', cookie).send({ flowId: 'pg-of', scope: 'all' });
    expect(flow.status).toBe(200);

    expect((await supertest(app).get('/v1/federation/directives')
      .set('Authorization', `Bearer ${token}`)).body.kind).toBe('upgrade.dispatch');
  });
});

describe('PG parity: upgrade progress reports (CGLAB-183)', () => {
  it('moves a target monotonically by sequence on Postgres', async () => {
    // The guard is `seq < ?` inside the UPDATE, alongside an org subquery —
    // the same shape that had to be rewritten for the eligibility query. And
    // `seq` is an INTEGER column bound from a JSON number, which is exactly
    // where the two backends have disagreed on numeric types before.
    const { app, db, cookie } = await bootHubOnPg({ releaseExists: async (v: string) => v === '1.2.3' });
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const { token, childHubId } = (await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-prog' } })).body;

    const created = await supertest(app).post('/v1/admin/upgrade-dispatches')
      .set('Cookie', cookie).send({ targetVersion: '1.2.3', scope: 'all' });
    expect(created.status).toBe(200);
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);

    const send = (seq: number, counts: Record<string, number>, completed: boolean) =>
      supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
        rows: [{ id: `ob-${seq}`, kind: 'event', payload: { event: {
          eventId: `upgrade-dispatch:${created.body.id}:${seq}`,
          type: 'fleet:upgrade-dispatch:progress',
          occurredAt: new Date().toISOString(), userKey: 'system',
          payload: { dispatchId: created.body.id, seq, counts, completed, skipped: [] },
        } } }],
      });

    const state = async () => (await db.get<any>(
      'SELECT state, seq FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      [created.body.id, childHubId],
    ));

    expect((await state()).state).toBe('pending');
    await send(2, { pending: 0, updated: 2, failed: 0, skipped: 0 }, true);
    expect((await state()).state).toBe('completed');
    expect(Number((await state()).seq)).toBe(2);

    // The late, older report must not walk it back.
    await send(1, { pending: 2, updated: 0, failed: 0, skipped: 0 }, false);
    expect((await state()).state).toBe('completed');
    expect(Number((await state()).seq)).toBe(2);
  });
});

describe('PG parity: the child side of a group upgrade (CGLAB-183, CGLAB-185)', () => {
  // The whole child-side path had NO Postgres coverage: upgrade_dispatch_fanout
  // was touched by no parity test at all. What these tests DO prove is that
  // every statement on that path parses and executes on the Postgres dialect —
  // which is not nothing, since eligibleInstallations' predicate had to be
  // rewritten once already after the correlated NOT EXISTS it started as
  // turned out to be inexecutable here.
  //
  // What they deliberately do NOT prove, because pg-mem does not reproduce it
  // (both verified against this backend rather than assumed):
  //   - `NULL NOT IN (...)`. Real Postgres yields NULL and drops the row; pg-mem
  //     returns it. So the COALESCE in eligibleInstallations — without which a
  //     machine with no git_email silently leaves every fleet-wide upgrade —
  //     cannot be demonstrated here. It is guarded by the SQLite suite instead
  //     ('includes an installation with no git email at all').
  //   - bigint typing. Real Postgres returns COUNT(*) as a string; pg-mem
  //     returns a JS number, so the Number() coercion in countsFor cannot be
  //     shown to be load-bearing here either.
  // Removing either guard leaves these tests green. That is a limit of the
  // parity backend, not a licence to remove them.
  it('fans out, reports and cancels against Postgres', async () => {
    const { db } = await bootHubOnPg();

    const now = new Date().toISOString();
    const add = (id: string, email: string, version: string | null, retired: boolean) => db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version, retired_at)
       VALUES (?, 'org', ?, ?, ?, ?, ${retired ? 'now()' : 'NULL'})`,
      [id, now, now, email, version],
    );
    await add('keep', 'keep@acme.com', '1.0.0', false);
    await add('gone', 'gone@acme.com', '1.0.0', true);
    await add('hid', 'hid@acme.com', '1.0.0', false);
    await add('anon', null as any, '1.0.0', false);
    await db.run("INSERT INTO hidden_users (org_id, user_key) VALUES ('org', 'hid@acme.com')");

    const fanout = await applyUpgradeDispatch(db, 'org', {
      kind: 'upgrade.dispatch', dispatchId: 'pg-fd1', targetVersion: '1.2.3',
    });
    // 'anon' has a NULL git_email. On REAL Postgres, dropping the COALESCE
    // would silently remove it from the fleet — but pg-mem returns it either
    // way, so this assertion does NOT cover that (see the note above; the
    // SQLite suite is what guards it).
    expect(fanout.outcome).toBe('applied');
    expect(fanout.upgraded).toBe(2);
    expect(fanout.skipped.map(s => s.reason).sort()).toEqual(['hidden', 'retired']);

    // Redelivery reads the recorded result back off upgrade_dispatch_fanout.
    const again = await applyUpgradeDispatch(db, 'org', {
      kind: 'upgrade.dispatch', dispatchId: 'pg-fd1', targetVersion: '1.2.3',
    });
    expect(again.outcome).toBe('already-applied');
    expect(again.upgraded).toBe(2);
    expect(again.skipped).toHaveLength(2);

    // COUNT(*) … GROUP BY state, read back through Number().
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'pg-child',
    });
    expect(await reportUpgradeProgress(db, 'org')).toBe(1);
    const [report] = (await db.all<any>('SELECT payload FROM federation_outbox ORDER BY seq'))
      .map(r => JSON.parse(r.payload)?.event)
      .filter((e: any) => e?.type === 'fleet:upgrade-dispatch:progress');
    expect(report.payload.counts).toMatchObject({ pending: 2, updated: 0, failed: 0, skipped: 2 });

    // The cancel's UPDATE, and the re-report it forces.
    const cancelled = await applyUpgradeCancel(db, 'org', { kind: 'upgrade.cancel', dispatchId: 'pg-fd1' });
    expect(cancelled.cancelled).toBe(2);
    expect(await reportUpgradeProgress(db, 'org')).toBe(1);

    // The other two cancel branches, neither of which the happy path reaches.
    // This one writes a fanout row through `INSERT OR IGNORE`, whose Postgres
    // form is an untargeted ON CONFLICT DO NOTHING produced by the dialect
    // rewrite — a different statement from the one above.
    const unknown = await applyUpgradeCancel(db, 'org', { kind: 'upgrade.cancel', dispatchId: 'pg-never-seen' });
    expect(unknown.cancelled).toBe(0);
    expect(unknown.error).toBeFalsy();
    const recorded = await db.get<any>(
      'SELECT outcome FROM upgrade_dispatch_fanout WHERE dispatch_id = ?', ['pg-never-seen'],
    );
    expect(recorded.outcome).toBe('nothing-to-do');

    await db.close();
  });

  it('cancels a fan-out that had nothing to do, on Postgres', async () => {
    // The `!row.directive_id` branch: a recorded dispatch that wrote no local
    // directive because every machine was skipped. Its cancel clears the
    // reported snapshot and nothing else.
    const { db } = await bootHubOnPg();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version, retired_at)
       VALUES ('gone', 'org', ?, ?, 'gone@acme.com', '1.0.0', now())`, [now, now],
    );
    const out = await applyUpgradeDispatch(db, 'org', {
      kind: 'upgrade.dispatch', dispatchId: 'pg-empty', targetVersion: '1.2.3',
    });
    expect(out.outcome).toBe('nothing-to-do');

    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'pg-c2',
    });
    expect(await reportUpgradeProgress(db, 'org')).toBe(1);
    expect(await reportUpgradeProgress(db, 'org')).toBe(0);

    const cancelled = await applyUpgradeCancel(db, 'org', { kind: 'upgrade.cancel', dispatchId: 'pg-empty' });
    expect(cancelled.cancelled).toBe(0);
    // Cleared, so the hub speaks again rather than leaving the parent waiting.
    expect(await reportUpgradeProgress(db, 'org')).toBe(1);

    await db.close();
  });

  it('releases parent-origin flows back to local, on Postgres', async () => {
    // parentFlows' UPDATE is the detach path and was imported by neither
    // parity suite.
    const { db } = await bootHubOnPg();
    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES ('pg-pf', 'org', 'Group TDD', ?, 'parent', 2)`,
      [JSON.stringify({ name: 'Group TDD', steps: [{ id: 's0', name: 'TODO', order: 0 }] })],
    );
    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES ('pg-own', 'org', 'Ours', ?, 'hub', 1)`,
      [JSON.stringify({ name: 'Ours', steps: [{ id: 's0', name: 'TODO', order: 0 }] })],
    );

    const released = await releaseParentFlows(db);
    expect(released).toBe(1);
    expect((await db.get<any>('SELECT source FROM flows WHERE id = ?', ['pg-pf'])).source).toBe('hub');
    expect((await db.get<any>('SELECT source FROM flows WHERE id = ?', ['pg-own'])).source).toBe('hub');

    await db.close();
  });

  it('will not stack a second upgrade on a machine claimed BEFORE the fan-out, on Postgres', async () => {
    // Note this exercises the in-flight READ, not the conditional insert — the
    // machine is already claimed when the fan-out starts. The conditional
    // insert is covered by the test below.
    const { db } = await bootHubOnPg();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES ('i1', 'org', ?, ?, 'i1@acme.com', '1.0.0')`, [now, now],
    );
    await db.run(
      `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type) VALUES ('prior', 'org', '1.1.0', 'all')`,
    );
    await db.run(
      `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
       VALUES ('prior', 'i1', 'in_progress')`,
    );

    const out = await applyUpgradeDispatch(db, 'org', {
      kind: 'upgrade.dispatch', dispatchId: 'pg-fd2', targetVersion: '1.2.3',
    });
    expect(out.outcome).toBe('nothing-to-do');
    expect(out.skipped).toEqual([{ installationId: 'i1', reason: 'in-flight' }]);

    const rows = await db.all<any>(
      "SELECT directive_id FROM upgrade_directive_targets WHERE installation_id = 'i1'",
    );
    expect(rows).toHaveLength(1);
    await db.close();
  });

  it('will not stack a second upgrade on a machine claimed DURING the fan-out, on Postgres', async () => {
    // This is the conditional `INSERT … SELECT … WHERE NOT EXISTS`: the
    // claim lands after the in-flight set was read, so only the guard inside
    // the statement can stop it. On SQLite that is one statement; the dialect
    // translator has to keep it one statement here too, or the atomicity the
    // in-flight guard depends on is gone.
    const { db } = await bootHubOnPg();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES ('i1', 'org', ?, ?, 'i1@acme.com', '1.0.0')`, [now, now],
    );

    const realRun = db.run.bind(db);
    let claimed = false;
    (db as any).run = async (sql: string, params?: unknown[]) => {
      if (!claimed && /INSERT INTO upgrade_directives/i.test(sql)) {
        claimed = true;
        await realRun(
          `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type) VALUES ('racer','org','1.1.0','all')`,
        );
        await realRun(
          `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state) VALUES ('racer','i1','pending')`,
        );
      }
      return realRun(sql, params);
    };
    try {
      await applyUpgradeDispatch(db, 'org', {
        kind: 'upgrade.dispatch', dispatchId: 'pg-fd3', targetVersion: '1.2.3',
      });
    } finally {
      (db as any).run = realRun;
    }

    const rows = await db.all<any>(
      "SELECT directive_id FROM upgrade_directive_targets WHERE installation_id = 'i1' AND state IN ('pending','in_progress')",
    );
    expect(rows).toHaveLength(1);
    await db.close();
  });
});

describe('PG parity: the identity policy that governs forwarded identities (CGLAB-184)', () => {
  it('sets the group policy and a per-child override, on Postgres', async () => {
    // The whole premise of the group is that a parent's policy governs how
    // forwarded identities are shaped — and the WRITE half of it had zero
    // Postgres execution. The group write is an upsert
    // (`ON CONFLICT(org_id) DO UPDATE`), which is precisely the shape a
    // dialect can get wrong, and until now the reads were only ever exercised
    // against a NULL policy, so effectiveIdentityPolicy was tested on this
    // backend in its default branch only.
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const { childHubId } = (await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name: 'pg-idp' } })).body;

    // Upsert with no row present…
    expect((await supertest(app).put('/v1/admin/federation/identity-policy')
      .set('Cookie', cookie).send({ policy: 'pseudonymize' })).status).toBe(200);
    expect((await db.get<any>('SELECT identity_policy FROM org_settings WHERE org_id = ?', ['org']))
      .identity_policy).toBe('pseudonymize');

    // …and again with one, which is the DO UPDATE arm.
    expect((await supertest(app).put('/v1/admin/federation/identity-policy')
      .set('Cookie', cookie).send({ policy: 'keep' })).status).toBe(200);
    expect((await db.get<any>('SELECT identity_policy FROM org_settings WHERE org_id = ?', ['org']))
      .identity_policy).toBe('keep');

    // The per-child override wins in BOTH directions, so it is set against a
    // group default that differs from it.
    expect((await supertest(app).put(`/v1/admin/child-hubs/${childHubId}/identity-policy`)
      .set('Cookie', cookie).send({ policy: 'pseudonymize' })).status).toBe(200);
    expect((await db.get<any>('SELECT identity_policy FROM child_hubs WHERE id = ?', [childHubId]))
      .identity_policy).toBe('pseudonymize');

    const read = await supertest(app).get('/v1/admin/federation/identity-policy').set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body.groupPolicy).toBe('keep');
    const child = read.body.childHubs.find((c: any) => c.id === childHubId);
    expect(child.policy).toBe('pseudonymize');
    // The override wins over a DIFFERENT group default — the direction that
    // proves it is an override rather than an escalation.
    expect(child.effective).toBe('pseudonymize');

    await db.close();
  });
});
