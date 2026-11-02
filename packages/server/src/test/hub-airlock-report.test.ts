/**
 * The installation tells the hub which Airlock policy it applies (GH-294, HUB-2).
 *
 * After each sync, `runAirlockSync` reports through `report` - which the
 * server wires to its hub event outbox, as fleet upgrades report theirs:
 *  - `airlock.policy-applied` with the revision and IOC revision of the hub row
 *    it holds from this authority, whether just adopted or revalidated (304);
 *  - `airlock.policy-refused` when the hub's answer failed validation, with
 *    the policy and IOC revisions refused and why. What it applies stays what it had.
 * Each is sent once per state, not once per tick, again after the hub
 * configuration changes, and again once the resend interval has passed (so a
 * report the hub never stored heals). A report that could not be enqueued
 * (the reporter returns false) is sent again on the next sync. A transport failure says nothing new, so it reports
 * nothing. A report that throws never changes what is applied, and is tried
 * again on the next sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { removeTestDb } from './helpers/testDb';
import { runFlowSyncTick, startFlowSync } from '../hub/flowSync';
import { runAirlockSync, invalidateAirlockSyncs, airlockAuthorityOf, AIRLOCK_REPORT_RESEND_MS, type AirlockApplyReport, type AirlockApplyReporter } from '../hub/airlockSync';

const HUB_A = { url: 'http://hub.example.test', token: 'agk_test', orgId: 'org-a' };

const hubPolicy = (over: Record<string, unknown> = {}, iocRevision = 1) => ({
  schemaVersion: 1,
  mode: 'enforce',
  models: [{ client: 'pi' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: [] },
  iocHosts: { revision: String(iocRevision), hosts: ['bad.example'], updatedAt: '2026-10-20T00:00:00.000Z' },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
  ...over,
});

interface Answer { status: number; body?: any; etag?: string }

function answer(r: Answer) {
  const headers: Record<string, string> = {};
  if (r.etag) headers['etag'] = r.etag;
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => r.body ?? {},
  } as any;
}

const ok = (policy: any, revision: number, iocRevision = 1): Answer =>
  ({ status: 200, body: { policy, revision, iocRevision }, etag: `W/"${revision}:${iocRevision}"` });

function fetchAnswering(airlock: Answer | 'throw') {
  return vi.fn(async (url: string) => {
    if (url.includes('/v1/airlock/policy')) {
      if (airlock === 'throw') throw new Error('ECONNREFUSED');
      return answer(airlock);
    }
    if (url.includes('/v1/flows/active')) return answer({ status: 200, body: { flow: null } });
    return answer({ status: 404, body: {} });
  }) as any;
}

describe('the installation reports the Airlock revision it applies', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let stateFile: string;
  let reports: AirlockApplyReport[];
  const report = (r: AirlockApplyReport) => { reports.push(r); };

  beforeEach(async () => {
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `hub-airlock-report-${id}.sqlite`);
    stateFile = path.join(os.tmpdir(), `airlock-state-report-${id}.json`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    reports = [];
    // Each spec starts as a fresh configuration: nothing reported yet.
    invalidateAirlockSyncs();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTestDb(dbPath, () => storage.shutdown());
    fs.rmSync(stateFile, { force: true });
  });

  /** `null`: a sync that reports nothing, as the refresh route runs it. */
  const sync = (airlock: Answer | 'throw', withReport: AirlockApplyReporter | null = report) =>
    runAirlockSync({ storage, hubConfig: HUB_A, fetchImpl: fetchAnswering(airlock), stateFile, emit: vi.fn(), report: withReport ?? undefined });

  async function seedHubRow(revision: number, iocRevision = 1) {
    await storage.putAirlockPolicy({
      scope: 'hub', revision, policy: normalizeAirlockPolicy(hubPolicy({}, iocRevision)),
      updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: airlockAuthorityOf(HUB_A), authority: 'hub',
      etag: `W/"${revision}:${iocRevision}"`,
    }, 0);
  }

  it('an adoption reports the revision and IOC revision applied', async () => {
    const out = await sync(ok(hubPolicy({}, 2), 5, 2));
    expect(out.outcome).toBe('adopted');
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 5, iocRevision: 2 } }]);
  });

  it('a 304 reports the revision held once; the next 304 reports nothing', async () => {
    await seedHubRow(3, 1);
    expect((await sync({ status: 304 })).outcome).toBe('not-modified');
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 3, iocRevision: 1 } }]);
    await sync({ status: 304 });
    expect(reports).toHaveLength(1);
  });

  it('a revision adopted by a sync that did not report (a refresh) is reported by the next one', async () => {
    await sync(ok(hubPolicy(), 4), null);
    expect(reports).toEqual([]);
    await sync({ status: 304 });
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 4, iocRevision: 1 } }]);
  });

  it('a new revision is reported after an older one was', async () => {
    await sync(ok(hubPolicy(), 4));
    await sync(ok(hubPolicy(), 5));
    expect(reports.map(r => r.payload)).toEqual([{ revision: 4, iocRevision: 1 }, { revision: 5, iocRevision: 1 }]);
  });

  it('an invalid policy is reported as refused, and what is applied is still the stored revision', async () => {
    await seedHubRow(3);
    const out = await sync(ok(hubPolicy({ hosts: { allow: ['169.254.169.254'], deny: [] } }), 4));
    expect(out.outcome).toBe('error');
    expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(3);
    expect(reports[0]).toEqual({ type: 'airlock.policy-applied', payload: { revision: 3, iocRevision: 1 } });
    expect(reports[1].type).toBe('airlock.policy-refused');
    expect(reports[1].payload).toMatchObject({ revision: 4, iocRevision: 1 });
    expect((reports[1].payload as any).error).toMatch(/invalid Airlock policy/);
    expect(reports).toHaveLength(2);
  });

  it('an incomplete policy is reported as refused too', async () => {
    const { rules: _r, ...partial } = hubPolicy();
    await sync(ok(partial, 6));
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('airlock.policy-refused');
    expect(reports[0].payload).toMatchObject({ revision: 6, iocRevision: 1 });
    expect((reports[0].payload as any).error).toMatch(/incomplete/);
  });

  it('a refused IOC-only change names the IOC revision it refused, not only the policy revision', async () => {
    await seedHubRow(3, 1);
    await sync(ok(hubPolicy({ hosts: { allow: ['169.254.169.254'], deny: [] } }, 2), 3, 2));
    expect(reports).toEqual([
      { type: 'airlock.policy-applied', payload: { revision: 3, iocRevision: 1 } },
      expect.objectContaining({ type: 'airlock.policy-refused', payload: expect.objectContaining({ revision: 3, iocRevision: 2 }) }),
    ]);
  });

  it('the same refusal is reported once, not every tick', async () => {
    const bad = ok(hubPolicy({ hosts: { allow: ['169.254.169.254'], deny: [] } }), 4);
    await sync(bad);
    await sync(bad);
    expect(reports.filter(r => r.type === 'airlock.policy-refused')).toHaveLength(1);
  });

  it('a hub that is down or answers 500 reports nothing', async () => {
    await seedHubRow(3);
    await sync('throw');
    await sync({ status: 500 });
    expect(reports).toEqual([]);
  });

  it('a report that throws changes nothing that is applied, and is tried again on the next sync', async () => {
    const failing = vi.fn(() => { throw new Error('outbox full'); });
    const out = await sync(ok(hubPolicy(), 5), failing);
    expect(out.outcome).toBe('adopted');
    expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(5);
    expect(failing).toHaveBeenCalledTimes(1);
    await sync({ status: 304 });
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 5, iocRevision: 1 } }]);
  });

  it('a report that could not be enqueued is sent again on the next sync', async () => {
    await seedHubRow(3);
    const notEnqueued = vi.fn(() => false);
    await sync({ status: 304 }, notEnqueued);
    expect(notEnqueued).toHaveBeenCalledTimes(1);
    await sync({ status: 304 });
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 3, iocRevision: 1 } }]);
  });

  it('the same state is sent again once the resend interval has passed, not before', async () => {
    await seedHubRow(3);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await sync({ status: 304 });
    clock.mockReturnValue(t0 + AIRLOCK_REPORT_RESEND_MS - 1);
    await sync({ status: 304 });
    expect(reports).toHaveLength(1);
    clock.mockReturnValue(t0 + AIRLOCK_REPORT_RESEND_MS);
    await sync({ status: 304 });
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
  });

  it('a refusal is sent again once the resend interval has passed', async () => {
    const bad = ok(hubPolicy({ hosts: { allow: ['169.254.169.254'], deny: [] } }), 4);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await sync(bad);
    clock.mockReturnValue(t0 + AIRLOCK_REPORT_RESEND_MS);
    await sync(bad);
    expect(reports.filter(r => r.type === 'airlock.policy-refused')).toHaveLength(2);
  });

  it('a hub configuration change reports the revision held again', async () => {
    await seedHubRow(3);
    await sync({ status: 304 });
    invalidateAirlockSyncs();
    await sync({ status: 304 });
    expect(reports).toHaveLength(2);
  });

  it('a hub with no policy reports nothing', async () => {
    await sync({ status: 200, body: { policy: null, revision: 0 }, etag: 'W/"0:0"' });
    expect(reports).toEqual([]);
  });

  it('runFlowSyncTick hands its reporter to the Airlock sync', async () => {
    await runFlowSyncTick({
      storage, hubConfig: HUB_A, fetchImpl: fetchAnswering(ok(hubPolicy(), 2)), emit: vi.fn(),
      etagCache: new Map(), airlockStateFile: stateFile, reportAirlock: report,
    });
    expect(reports).toEqual([{ type: 'airlock.policy-applied', payload: { revision: 2, iocRevision: 1 } }]);
  });

  it('startFlowSync hands its reporter to every tick', async () => {
    vi.stubEnv('AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', '0');
    const handle = startFlowSync({
      storage, hubConfig: HUB_A, fetchImpl: fetchAnswering(ok(hubPolicy(), 2)), emit: vi.fn(), reportAirlock: report,
    });
    try {
      const deadline = Date.now() + 3000;
      while (reports.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    } finally {
      handle.stop();
      vi.unstubAllEnvs();
    }
    expect(reports[0]).toEqual({ type: 'airlock.policy-applied', payload: { revision: 2, iocRevision: 1 } });
  });
});
