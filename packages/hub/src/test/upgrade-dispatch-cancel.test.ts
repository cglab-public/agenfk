// Cancelling a group upgrade (CGLAB-183, task 4).
//
// A cancel at the parent has to reach hubs that already took the directive.
// It travels as a NEW `upgrade.cancel` kind on the existing feed (confirmed
// with the user), which an older child ignores safely instead of breaking.
//
// The parent still never assumes. Cancelling moves each non-terminal target to
// `cancel-pending` — asked to stop, not yet confirmed — and only the child's
// ordinary progress report moves it to `cancelled`. A hub that never polls the
// cancel is shown as still being asked, which is the truth.
//
// A cancel cannot un-upgrade a machine that already finished; it stops the
// pending ones, exactly as the local cancel does today.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { applyUpgradeDispatch } from '../services/federation/upgradeFanout';
import { applyUpgradeCancel } from '../services/federation/upgradeCancel';

const SECRET = 'a'.repeat(64);
const ORG = 'org';
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-updispcan-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

// ── the parent half ───────────────────────────────────────────────────────

describe('the parent asks its children to stop', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }

  const directives = (token: string) =>
    supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);

  const target = (dispatchId: string, childHubId: string) => ctx.db.get<any>(
    'SELECT state FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
    [dispatchId, childHubId],
  );

  const progress = (token: string, dispatchId: string, seq: number, counts: any, completed: boolean) =>
    supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
      rows: [{ id: `ob-${dispatchId}-${seq}`, kind: 'event', payload: { event: {
        eventId: `upgrade-dispatch:${dispatchId}:${seq}`,
        type: 'fleet:upgrade-dispatch:progress',
        occurredAt: new Date().toISOString(), userKey: 'system',
        payload: { dispatchId, seq, counts, completed, skipped: [] },
      } } }],
    });

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: ORG,
      releaseExists: async (v: string) => v === '1.2.3',
    } as any);
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, ORG, 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  const dispatch = async () => {
    const r = await supertest(app).post('/v1/admin/upgrade-dispatches')
      .set('Cookie', cookie).send({ targetVersion: '1.2.3', scope: 'all' });
    expect(r.status).toBe(200);
    return r.body.id as string;
  };
  const cancel = (id: string) =>
    supertest(app).post(`/v1/admin/upgrade-dispatches/${id}/cancel`).set('Cookie', cookie);

  it('serves a cancel to a hub that already took the directive', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);

    const served = await directives(a.token);
    expect(served.status).toBe(200);
    expect(served.body.kind).toBe('upgrade.cancel');
    expect(served.body.dispatchId).toBe(d);
  });

  it('marks the target cancel-pending, NOT cancelled, until the child confirms', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);

    expect((await target(d, a.childHubId)).state).toBe('cancel-pending');

    // The child stops and reports; only now is it actually cancelled.
    await progress(a.token, d, 1, { pending: 0, updated: 0, failed: 1, skipped: 0 }, true);
    expect((await target(d, a.childHubId)).state).toBe('cancelled');
  });

  it('a hub that never polls the cancel keeps showing as still being asked', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    const d = await dispatch();
    await directives(a.token);
    await directives(b.token);
    await cancel(d);

    await progress(a.token, d, 1, { pending: 0, updated: 0, failed: 1, skipped: 0 }, true);
    expect((await target(d, a.childHubId)).state).toBe('cancelled');
    expect((await target(d, b.childHubId)).state).toBe('cancel-pending');
  });

  it('does not serve a cancel to a hub that never took the directive', async () => {
    // Nothing to stop. Handing it a cancel for work it never started would put
    // a row on its board for something it never did.
    const a = await enroll('alpha');
    const d = await dispatch();
    await cancel(d);
    expect((await directives(a.token)).status).toBe(204);
  });

  it('keeps serving the cancel until the child answers', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);

    expect((await directives(a.token)).body.kind).toBe('upgrade.cancel');
    expect((await directives(a.token)).body.kind).toBe('upgrade.cancel');

    await progress(a.token, d, 1, { pending: 0, updated: 0, failed: 1, skipped: 0 }, true);
    expect((await directives(a.token)).status).toBe(204);
  });

  it('leaves a hub that already finished alone', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await progress(a.token, d, 1, { pending: 0, updated: 2, failed: 0, skipped: 0 }, true);
    expect((await target(d, a.childHubId)).state).toBe('completed');

    await cancel(d);
    // Completed is terminal: a cancel cannot un-upgrade what already landed.
    expect((await target(d, a.childHubId)).state).toBe('completed');
    expect((await directives(a.token)).status).toBe(204);
  });

  it('a progress report in flight cannot erase the cancel', async () => {
    // The killer case. The child queues a report, the admin cancels, then the
    // report drains. If it is allowed to move the row out of cancel-pending,
    // the cancel is never served again (no cancel-pending row) and the upgrade
    // is never re-served either (the dispatch is cancelled) — the child hears
    // nothing, upgrades the whole fleet, and its eventual completion is then
    // stamped 'cancelled' on the board. The parent would be reporting the
    // exact opposite of what happened.
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await progress(a.token, d, 4, { pending: 2, updated: 0, failed: 0, skipped: 0 }, false);
    await cancel(d);
    expect((await target(d, a.childHubId)).state).toBe('cancel-pending');

    // The in-flight report, with a HIGHER sequence, arriving after the cancel.
    await progress(a.token, d, 5, { pending: 1, updated: 1, failed: 0, skipped: 0 }, false);
    expect((await target(d, a.childHubId)).state).toBe('cancel-pending');

    // And the cancel is still on offer, so the child still finds out.
    expect((await directives(a.token)).body.kind).toBe('upgrade.cancel');
  });

  it('a completed report still settles a cancelled dispatch as stopped', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);
    await progress(a.token, d, 3, { pending: 0, updated: 0, failed: 2, skipped: 0 }, true);
    expect((await target(d, a.childHubId)).state).toBe('cancelled');
  });

  it('stops re-serving a cancel a child never answers, instead of wedging its whole feed', async () => {
    // A cancel outranks every other directive and is re-served until answered.
    // An older child that does not understand the kind never answers — so
    // without a bound, that hub would be handed the same cancel forever and
    // every flow dispatch and future upgrade to it would starve behind it.
    // The target stays cancel-pending, because the parent still does not know
    // what happened; it just stops shouting.
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);

    let served = 0;
    for (let i = 0; i < 12; i++) {
      const r = await directives(a.token);
      if (r.status === 200 && r.body.kind === 'upgrade.cancel') served++;
      else break;
    }
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(12);

    // Honest: still not confirmed.
    expect((await target(d, a.childHubId)).state).toBe('cancel-pending');
  });

  it('an unanswered cancel does not starve a later flow dispatch to that hub', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);
    for (let i = 0; i < 12; i++) await directives(a.token);

    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['f1', ORG, 'F', JSON.stringify({ name: 'F', steps: [{ id: 's0', name: 'T', order: 0 }] })],
    );
    expect((await supertest(app).post('/v1/admin/flow-dispatches')
      .set('Cookie', cookie).send({ flowId: 'f1', scope: 'all' })).status).toBe(200);

    expect((await directives(a.token)).body.kind).toBe('flow.dispatch');
    expect(d).toBeTruthy();
  });

  it('shows the cancellation on the admin board', async () => {
    const a = await enroll('alpha');
    const d = await dispatch();
    await directives(a.token);
    await cancel(d);

    const list = await supertest(app).get('/v1/admin/upgrade-dispatches').set('Cookie', cookie);
    const row = list.body.dispatches.find((x: any) => x.id === d);
    expect(row.cancelledAt).toBeTruthy();
    expect(row.targets[0].state).toBe('cancel-pending');
  });
});

// ── the child half ────────────────────────────────────────────────────────

describe('a child told to stop', () => {
  let db: HubDb;

  const install = async (id: string) => {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES (?, ?, ?, ?, ?, '1.0.0')`,
      [id, ORG, now, now, `${id}@acme.com`],
    );
  };

  const states = () => db.all<any>(
    'SELECT installation_id, state FROM upgrade_directive_targets ORDER BY installation_id',
  );

  beforeEach(async () => {
    db = await openDb(':memory:');
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', [ORG, ORG]);
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
  });

  const fanOut = async (ids: string[]) => {
    for (const id of ids) await install(id);
    return applyUpgradeDispatch(db, ORG, {
      kind: 'upgrade.dispatch', dispatchId: 'd-1', targetVersion: '1.2.3',
    });
  };

  it('stops every machine that had not started', async () => {
    await fanOut(['i1', 'i2']);
    const out = await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel', dispatchId: 'd-1' });

    expect(out.cancelled).toBe(2);
    expect((await states()).every(t => t.state === 'cancelled')).toBe(true);
  });

  it('does not un-upgrade a machine that already finished', async () => {
    await fanOut(['done', 'waiting']);
    await db.run("UPDATE upgrade_directive_targets SET state = 'succeeded' WHERE installation_id = 'done'");

    const out = await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel', dispatchId: 'd-1' });

    expect(out.cancelled).toBe(1);
    const byId = Object.fromEntries((await states()).map(t => [t.installation_id, t.state]));
    expect(byId.done).toBe('succeeded');
    expect(byId.waiting).toBe('cancelled');
  });

  it('leaves a machine mid-upgrade alone, exactly as the local cancel does', async () => {
    // Deliberate, and worth pinning because it differs from the local route,
    // which offers a force option. A machine already installing cannot be
    // called back, and claiming otherwise would be a worse lie than the delay.
    await fanOut(['busy', 'waiting']);
    await db.run("UPDATE upgrade_directive_targets SET state = 'in_progress' WHERE installation_id = 'busy'");

    const out = await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel', dispatchId: 'd-1' });

    expect(out.cancelled).toBe(1);
    const byId = Object.fromEntries((await states()).map(t => [t.installation_id, t.state]));
    expect(byId.busy).toBe('in_progress');
    expect(byId.waiting).toBe('cancelled');
  });

  it('makes the child report again, so the parent learns it stopped', async () => {
    await fanOut(['i1']);
    const { reportUpgradeProgress } = await import('../services/federation/upgradeProgress');
    await reportUpgradeProgress(db, ORG);
    expect(await reportUpgradeProgress(db, ORG)).toBe(0);

    await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel', dispatchId: 'd-1' });
    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
  });

  it('is harmless for a dispatch this hub never carried out — but still ANSWERS it', async () => {
    // The parent created the target row when it served the directive, so it is
    // waiting on a hub that may have no record of it at all (the fan-out was
    // refused, or crashed, or the response was lost). Saying nothing leaves
    // the parent re-serving that cancel ahead of everything else forever.
    const { reportUpgradeProgress } = await import('../services/federation/upgradeProgress');
    const out = await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel', dispatchId: 'never' });
    expect(out.cancelled).toBe(0);
    expect(out.error).toBeFalsy();

    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
    const [r] = (await db.all<any>('SELECT payload FROM federation_outbox ORDER BY seq'))
      .map(x => JSON.parse(x.payload)?.event)
      .filter((e: any) => e?.type === 'fleet:upgrade-dispatch:progress');
    expect(r.payload.dispatchId).toBe('never');
    expect(r.payload.completed).toBe(true);
  });

  it('refuses a cancel with no dispatch id rather than cancelling everything', async () => {
    await fanOut(['i1']);
    const out = await applyUpgradeCancel(db, ORG, { kind: 'upgrade.cancel' } as any);
    expect(out.error).toBeTruthy();
    expect((await states()).every(t => t.state === 'pending')).toBe(true);
  });

  it('never reaches another org\'s directive', async () => {
    await fanOut(['i1']);
    const out = await applyUpgradeCancel(db, 'other', { kind: 'upgrade.cancel', dispatchId: 'd-1' });
    expect(out.cancelled).toBe(0);
    expect((await states()).every(t => t.state === 'pending')).toBe(true);
  });

  it('the tick carries out a cancel it pulls', async () => {
    await fanOut(['i1']);
    const { federationTick } = await import('../services/federation/federationSync');
    const t = {
      async ping() { return { ok: true }; },
      async directives() { return { kind: 'upgrade.cancel', dispatchId: 'd-1' }; },
      async deliver(rows: any[]) { return { accepted: rows.length }; },
    };
    await federationTick({ db, secretKey: SECRET, orgId: ORG, transport: t } as any);
    expect((await states()).every(s => s.state === 'cancelled')).toBe(true);
  });
});
