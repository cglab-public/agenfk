// A child reports how its group upgrade is actually going (CGLAB-183, task 3).
//
// The parent never assumes. It served a directive; what that did to a fleet of
// machines it cannot see is the child's to report, and the target row stays
// `pending` until it does.
//
// Cadence is ON CHANGE plus a final completion (confirmed with the user): a
// report goes out only when the counts actually move, and always one when the
// dispatch finishes. The parent's board stays live without an event per child
// per minute for the length of a rollout.
//
// The report carries a SEQUENCE. Delivery is at-least-once and an earlier
// report can drain after a later one, so progress is monotonic in that
// sequence — never first-writer-wins, which is the trap that pinned a flow
// dispatch at a stale value in CGLAB-182 task 4.
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
import { reportUpgradeProgress } from '../services/federation/upgradeProgress';

const SECRET = 'a'.repeat(64);
const ORG = 'org';
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-upprog-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

// ── the child half ────────────────────────────────────────────────────────

describe('a child reports its upgrade progress upstream', () => {
  let db: HubDb;

  const install = async (id: string) => {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES (?, ?, ?, ?, ?, '1.0.0')`,
      [id, ORG, now, now, `${id}@acme.com`],
    );
  };

  const setTarget = (installationId: string, state: string) =>
    db.run('UPDATE upgrade_directive_targets SET state = ? WHERE installation_id = ?', [state, installationId]);

  const queued = async () =>
    (await db.all<any>('SELECT payload FROM federation_outbox ORDER BY seq'))
      .map(r => JSON.parse(r.payload)?.event)
      .filter((e: any) => e?.type === 'fleet:upgrade-dispatch:progress');

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
      kind: 'upgrade.dispatch', dispatchId: 'd-1', targetVersion: '1.2.3', confirmDowngrade: false,
    });
  };

  it('reports the counts its fan-out produced', async () => {
    await fanOut(['i1', 'i2']);

    const sent = await reportUpgradeProgress(db, ORG);
    expect(sent).toBe(1);

    const [r] = await queued();
    expect(r.payload.dispatchId).toBe('d-1');
    expect(r.payload.counts).toMatchObject({ pending: 2, updated: 0, failed: 0, skipped: 0 });
    expect(r.payload.completed).toBe(false);
  });

  it('carries the skip reasons the fan-out recorded', async () => {
    await install('gone');
    await db.run('UPDATE installations SET retired_at = ? WHERE id = ?', [new Date().toISOString(), 'gone']);
    await fanOut(['i1']);

    await reportUpgradeProgress(db, ORG);
    const [r] = await queued();
    expect(r.payload.counts.skipped).toBe(1);
    expect(r.payload.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);
  });

  it('says NOTHING when nothing has moved since the last report', async () => {
    await fanOut(['i1']);
    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
    expect(await reportUpgradeProgress(db, ORG)).toBe(0);
    expect(await queued()).toHaveLength(1);
  });

  it('reports again as soon as a machine moves', async () => {
    await fanOut(['i1', 'i2']);
    await reportUpgradeProgress(db, ORG);
    await setTarget('i1', 'succeeded');

    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
    const all = await queued();
    expect(all).toHaveLength(2);
    expect(all[1].payload.counts).toMatchObject({ pending: 1, updated: 1 });
  });

  it('always reports the completion, and marks it', async () => {
    await fanOut(['i1']);
    await reportUpgradeProgress(db, ORG);
    await setTarget('i1', 'succeeded');

    await reportUpgradeProgress(db, ORG);
    const all = await queued();
    expect(all[all.length - 1].payload.completed).toBe(true);
    expect(all[all.length - 1].payload.counts).toMatchObject({ pending: 0, updated: 1 });
  });

  it('counts a failed machine as failed, and still completes', async () => {
    await fanOut(['i1', 'i2']);
    await setTarget('i1', 'succeeded');
    await setTarget('i2', 'failed');

    await reportUpgradeProgress(db, ORG);
    const [r] = await queued();
    expect(r.payload.counts).toMatchObject({ updated: 1, failed: 1, pending: 0 });
    expect(r.payload.completed).toBe(true);
  });

  it('stops reporting once the dispatch is complete', async () => {
    await fanOut(['i1']);
    await setTarget('i1', 'succeeded');
    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
    expect(await reportUpgradeProgress(db, ORG)).toBe(0);
  });

  it('reports a fan-out that had nothing to do, so the parent is not left waiting', async () => {
    await install('gone');
    await db.run('UPDATE installations SET retired_at = ? WHERE id = ?', [new Date().toISOString(), 'gone']);
    await applyUpgradeDispatch(db, ORG, {
      kind: 'upgrade.dispatch', dispatchId: 'd-1', targetVersion: '1.2.3',
    });

    expect(await reportUpgradeProgress(db, ORG)).toBe(1);
    const [r] = await queued();
    expect(r.payload.completed).toBe(true);
    expect(r.payload.counts).toMatchObject({ skipped: 1, pending: 0 });
  });

  it('gives each report a HIGHER sequence, so a later one can still land', async () => {
    // Not a stable id per dispatch: these reports supersede one another, so
    // the parent has to be able to tell which is newer. The id carries the
    // sequence, which is also what makes redelivery of the SAME report a
    // duplicate.
    await fanOut(['i1', 'i2']);
    await reportUpgradeProgress(db, ORG);
    await setTarget('i1', 'succeeded');
    await reportUpgradeProgress(db, ORG);

    const all = await queued();
    expect(all[0].payload.seq).toBe(1);
    expect(all[1].payload.seq).toBe(2);
    expect(all[0].eventId).not.toBe(all[1].eventId);
    expect(all[1].eventId).toContain('2');
  });

  it('reports each dispatch separately', async () => {
    await fanOut(['i1']);
    await install('i2');
    await applyUpgradeDispatch(db, ORG, {
      kind: 'upgrade.dispatch', dispatchId: 'd-2', targetVersion: '1.2.3',
    });

    await reportUpgradeProgress(db, ORG);
    const ids = (await queued()).map(r => r.payload.dispatchId).sort();
    expect(ids).toEqual(['d-1', 'd-2']);
  });
});

// ── the parent half ───────────────────────────────────────────────────────

describe('the parent records the progress its child reports', () => {
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

  const report = (token: string, seq: number, payload: Record<string, unknown>, eventId?: string) =>
    supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({
      rows: [{ id: `ob-${eventId ?? seq}`, kind: 'event', payload: { event: {
        eventId: eventId ?? `upgrade-dispatch:d-1:${seq}`,
        type: 'fleet:upgrade-dispatch:progress',
        occurredAt: new Date().toISOString(), userKey: 'system',
        payload: { dispatchId: 'd-1', seq, ...payload },
      } } }],
    });

  const target = (childHubId: string) => ctx.db.get<any>(
    'SELECT state, detail FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
    ['d-1', childHubId],
  );

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
    await ctx.db.run(
      `INSERT INTO upgrade_dispatches (id, org_id, target_version, scope_type, created_at)
       VALUES (?, ?, '1.2.3', 'all', ?)`,
      ['d-1', ORG, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('moves the target to running, with the counts', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    expect((await target(a.childHubId)).state).toBe('pending');

    const r = await report(a.token, 1, { counts: { pending: 2, updated: 0, failed: 0, skipped: 1 }, completed: false });
    expect(r.status).toBe(200);

    const t = await target(a.childHubId);
    expect(t.state).toBe('running');
    expect(JSON.parse(t.detail).counts).toMatchObject({ pending: 2, skipped: 1 });
  });

  it('marks it completed when the child says so', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await report(a.token, 1, { counts: { pending: 0, updated: 2, failed: 0, skipped: 0 }, completed: true });
    expect((await target(a.childHubId)).state).toBe('completed');
  });

  it('never moves progress BACKWARDS when an older report drains late', async () => {
    // The trap from CGLAB-182: an earlier queued report can arrive after a
    // later one, and a guard that simply takes the newest write pins the
    // board at a stale value.
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);

    await report(a.token, 2, { counts: { pending: 0, updated: 2, failed: 0, skipped: 0 }, completed: true });
    expect((await target(a.childHubId)).state).toBe('completed');

    await report(a.token, 1, { counts: { pending: 2, updated: 0, failed: 0, skipped: 0 }, completed: false });
    const t = await target(a.childHubId);
    expect(t.state).toBe('completed');
    expect(JSON.parse(t.detail).counts.updated).toBe(2);
  });

  it('counts a redelivered report once and changes nothing', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await report(a.token, 1, { counts: { pending: 1, updated: 0, failed: 0, skipped: 0 }, completed: false });
    const again = await report(a.token, 1, { counts: { pending: 1, updated: 0, failed: 0, skipped: 0 }, completed: false });
    expect(again.body.duplicates).toBe(1);
    expect((await target(a.childHubId)).state).toBe('running');
  });

  it('attributes the report to the CREDENTIAL, not the payload', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${b.token}`);

    await report(a.token, 1, {
      counts: { pending: 0, updated: 1, failed: 0, skipped: 0 }, completed: true, childHubId: b.childHubId,
    });

    expect((await target(a.childHubId)).state).toBe('completed');
    expect((await target(b.childHubId)).state).toBe('pending');
  });

  it('ignores a report for another org\'s dispatch', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run(
      `INSERT INTO upgrade_dispatches (id, org_id, target_version, scope_type, created_at)
       VALUES (?, 'org-b', '1.2.3', 'all', ?)`,
      ['d-other', new Date().toISOString()],
    );
    await ctx.db.run(
      `INSERT INTO upgrade_dispatch_targets (dispatch_id, child_hub_id, state, updated_at)
       VALUES (?, ?, 'pending', ?)`,
      ['d-other', a.childHubId, new Date().toISOString()],
    );
    await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${a.token}`).send({
      rows: [{ id: 'ob-x', kind: 'event', payload: { event: {
        eventId: 'upgrade-dispatch:d-other:1', type: 'fleet:upgrade-dispatch:progress',
        occurredAt: new Date().toISOString(), userKey: 'system',
        payload: { dispatchId: 'd-other', seq: 1, counts: { pending: 0, updated: 1, failed: 0, skipped: 0 }, completed: true },
      } } }],
    });
    expect((await ctx.db.get<any>(
      'SELECT state FROM upgrade_dispatch_targets WHERE dispatch_id = ?', ['d-other'])).state).toBe('pending');
  });

  it('is not filterable by the hidden-people control', async () => {
    // Control plane riding the telemetry pipe under a non-person key. An admin
    // who hid that key would otherwise stall every rollout silently: the
    // target stays pending, the feed keeps serving, and nothing is logged.
    // The flow-dispatch report was already exempt; this one has to be too, or
    // the exemption is a rule that holds for one of two identical cases.
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', [ORG, 'system']);

    await report(a.token, 1, { counts: { pending: 0, updated: 1, failed: 0, skipped: 0 }, completed: true });
    expect((await target(a.childHubId)).state).toBe('completed');
  });

  it('shows the progress on the admin board', async () => {
    const a = await enroll('alpha');
    await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`);
    await report(a.token, 1, {
      counts: { pending: 0, updated: 3, failed: 1, skipped: 2 }, completed: true,
      skipped: [{ installationId: 'x', reason: 'retired' }],
    });

    const list = await supertest(app).get('/v1/admin/upgrade-dispatches').set('Cookie', cookie);
    const row = list.body.dispatches.find((d: any) => d.id === 'd-1');
    expect(row.targets[0].state).toBe('completed');
    expect(row.targets[0].detail.counts).toMatchObject({ updated: 3, failed: 1, skipped: 2 });
    expect(row.targets[0].detail.skipped).toEqual([{ installationId: 'x', reason: 'retired' }]);
  });
});

describe('the tick reports progress without being asked', () => {
  let db: HubDb;

  const transport = (d: unknown) => ({
    async ping() { return { ok: true }; },
    async directives() { return d; },
    async deliver(rows: any[]) { (transport as any).sent = rows; return { accepted: rows.length }; },
  });

  beforeEach(async () => {
    db = await openDb(':memory:');
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', [ORG, ORG]);
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES ('i1', ?, ?, ?, 'i1@acme.com', '1.0.0')`,
      [ORG, now, now],
    );
  });

  it('fans out and reports in the same tick, so the parent hears on the first pass', async () => {
    const { federationTick } = await import('../services/federation/federationSync');
    const sent: any[] = [];
    const t = {
      async ping() { return { ok: true }; },
      async directives() {
        return { kind: 'upgrade.dispatch', dispatchId: 'd-1', targetVersion: '1.2.3', confirmDowngrade: false };
      },
      async deliver(rows: any[]) { sent.push(...rows); return { accepted: rows.length }; },
    };
    await federationTick({ db, secretKey: SECRET, orgId: ORG, transport: t } as any);

    const progress = sent
      .map(r => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload)?.event)
      .filter((e: any) => e?.type === 'fleet:upgrade-dispatch:progress');
    expect(progress).toHaveLength(1);
    expect(progress[0].payload.counts.pending).toBe(1);
  });

  it('sends nothing on a quiet tick', async () => {
    const { federationTick } = await import('../services/federation/federationSync');
    const sent: any[] = [];
    const t = {
      async ping() { return { ok: true }; },
      async directives() { return null; },
      async deliver(rows: any[]) { sent.push(...rows); return { accepted: rows.length }; },
    };
    await federationTick({ db, secretKey: SECRET, orgId: ORG, transport: t } as any);
    expect(sent).toHaveLength(0);
  });
});
