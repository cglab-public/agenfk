/**
 * The client side of the hub's Airlock policy (GH-294, T3).
 *
 * `syncAirlockPolicy` pulls the org's policy from `GET /v1/airlock/policy` and
 * stores it as the 'hub' row, which then outranks the local one. Modelled on
 * syncRepoSettings: a hub that is down, slow or wrong never erases what is
 * already stored, and a policy that is invalid or incomplete is refused WHOLE.
 *
 * The stored hub row is bound to the authority it came from (hub URL + org):
 * its ETag is only ever offered back to that authority, and a different
 * authority's answer replaces it rather than being compared with it. Within one
 * authority a response older than what is stored - by policy revision, then IOC
 * revision - is refused, so responses landing out of order cannot roll the
 * protection back. Leaving the hub (`releaseHubAirlockPolicy`) supersedes every
 * sync still in flight, so a late answer cannot hand ownership back to a hub
 * this installation has left.
 *
 * `runFlowSyncTick` calls it once per tick at org scope, projects or not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { removeTestDb } from './helpers/testDb';
import { runFlowSyncTick } from '../hub/flowSync';
import { syncAirlockPolicy, releaseHubAirlockPolicy, invalidateAirlockSyncs, airlockAuthorityOf } from '../hub/airlockSync';
import { resolveAirlockPolicy } from '../airlock/routes';

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_A = { url: HUB_URL, token: HUB_TOKEN, orgId: 'org-a' };
const HUB_B = { url: HUB_URL, token: 'agk_other', orgId: 'org-b' };

/** A policy exactly as the hub sends one: every field present. */
const hubPolicy = (over: Record<string, unknown> = {}, iocRevision = 1, iocHosts = ['bad.example']) => ({
  schemaVersion: 1,
  mode: 'enforce',
  models: [{ client: 'pi' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: ['evil.example'] },
  iocHosts: { revision: String(iocRevision), hosts: iocHosts, updatedAt: '2026-10-20T00:00:00.000Z' },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
  ...over,
});

interface Answer { status: number; body?: any; etag?: string }
interface Call { url: string; headers: Record<string, string> }

function answer(r: Answer) {
  const headers: Record<string, string> = {};
  if (r.etag) headers['etag'] = r.etag;
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (r.body === '__not_json__') throw new SyntaxError('Unexpected token');
      return r.body ?? {};
    },
  } as any;
}

const ok = (policy: any, revision: number, iocRevision = 1): Answer =>
  ({ status: 200, body: { policy, revision, iocRevision }, etag: `W/"${revision}:${iocRevision}"` });

/** A fetch that answers the airlock route with `airlock`, flows with nothing, and records every call. */
function makeFetch(airlock: Answer | 'throw') {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, opts: any) => {
    calls.push({ url, headers: opts?.headers ?? {} });
    if (url.includes('/v1/airlock/policy')) {
      if (airlock === 'throw') throw new Error('ECONNREFUSED');
      return answer(airlock);
    }
    if (url.includes('/v1/flows/active')) return answer({ status: 200, body: { flow: null } });
    return answer({ status: 404, body: { error: 'no route' } });
  });
  return { fetchImpl: fetchImpl as any, calls };
}

/** A fetch whose answers the spec releases one by one, in any order. */
function makeDeferredFetch() {
  const pending: Array<(a: Answer) => void> = [];
  const fetchImpl = vi.fn(() => new Promise<any>((resolve) => { pending.push((a) => resolve(answer(a))); }));
  const started = async (n: number) => { while (pending.length < n) await new Promise(r => setTimeout(r, 1)); };
  return { fetchImpl: fetchImpl as any, pending, started };
}

describe('hub airlockSync', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let stateFile: string;

  beforeEach(async () => {
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `hub-airlock-sync-${id}.sqlite`);
    stateFile = path.join(os.tmpdir(), `airlock-state-${id}.json`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTestDb(dbPath, () => storage.shutdown());
    fs.rmSync(stateFile, { force: true });
  });

  const sync = (fetchImpl: any, hubConfig = HUB_A) => syncAirlockPolicy({ storage, hubConfig, fetchImpl, stateFile });

  /** A hub row as an earlier sync from `hubConfig` would have left it. */
  async function seedHubRow(revision = 3, mode: 'observe' | 'enforce' = 'observe', hubConfig = HUB_A, iocRevision = 1) {
    await storage.putAirlockPolicy({
      scope: 'hub', revision, policy: normalizeAirlockPolicy(hubPolicy({ mode }, iocRevision)),
      updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: airlockAuthorityOf(hubConfig), authority: 'hub',
      etag: `W/"${revision}:${iocRevision}"`,
    }, 0);
  }

  describe('syncAirlockPolicy', () => {
    it('adopts the hub policy into the hub row, asking with the bearer token and no ETag when nothing is stored', async () => {
      const { fetchImpl, calls } = makeFetch(ok(hubPolicy(), 5));
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('adopted');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${HUB_URL}/v1/airlock/policy`);
      expect(calls[0].headers.Authorization).toBe(`Bearer ${HUB_TOKEN}`);
      expect(calls[0].headers['If-None-Match']).toBeUndefined();

      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(5);
      expect(row?.authority).toBe('hub');
      expect(row?.updatedBy).toBe(airlockAuthorityOf(HUB_A));
      expect(row?.etag).toBe('W/"5:1"');
      expect(row?.policy.mode).toBe('enforce');
      expect(row?.policy.iocHosts.hosts).toEqual(['bad.example']);
      expect((await resolveAirlockPolicy(storage, true)).source).toBe('hub');
    });

    it('rewrites the adapters state file after adopting', async () => {
      const { fetchImpl } = makeFetch(ok(hubPolicy(), 5));
      await sync(fetchImpl);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.mode).toBe('enforce');
      expect(state.revision).toBe(5);
      expect(state.source).toBe('hub');
    });

    it("offers the stored row's ETag to the same authority, and a 304 writes nothing", async () => {
      await seedHubRow(3);
      const { fetchImpl, calls } = makeFetch({ status: 304 });
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('not-modified');
      expect(calls[0].headers['If-None-Match']).toBe('W/"3:1"');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(3);
      expect(row?.policy.mode).toBe('observe');
      expect(fs.existsSync(stateFile)).toBe(false);
    });

    it.each<[string, Answer | 'throw']>([
      ['an HTTP error', { status: 500, body: { error: 'boom' } }],
      ['a network failure', 'throw'],
      ['a body that is not JSON', { status: 200, body: '__not_json__', etag: 'W/"9:9"' }],
      ['a body with no revision', { status: 200, body: { policy: hubPolicy() }, etag: 'W/"9:9"' }],
      ['a body whose policy is not an object', { status: 200, body: { policy: 'enforce', revision: 9 }, etag: 'W/"9:9"' }],
    ])('%s never erases the stored hub row', async (_label, hub) => {
      await seedHubRow(3);
      const { fetchImpl } = makeFetch(hub);
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('error');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(3);
      expect(row?.policy.mode).toBe('observe');
    });

    it('refuses an invalid policy whole: nothing of it is stored', async () => {
      await seedHubRow(3);
      const invalid = hubPolicy({ hosts: { allow: ['169.254.169.254', 'github.com'], deny: [] } });
      const { fetchImpl } = makeFetch(ok(invalid, 4));
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('error');
      if (out.outcome === 'error') expect(out.error).toMatch(/metadata/);
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(3);
    });

    it.each<[string, any]>([
      ['an empty policy', {}],
      ['a policy with no mode', (({ mode: _m, ...rest }) => rest)(hubPolicy())],
      ['a policy with no rules', (({ rules: _r, ...rest }) => rest)(hubPolicy())],
      ['a policy with a rule missing', hubPolicy({ rules: { uploadToUnlistedHost: 'deny' } })],
      ['a policy with no hosts', (({ hosts: _h, ...rest }) => rest)(hubPolicy())],
      ['a policy with no models', (({ models: _m, ...rest }) => rest)(hubPolicy())],
      ['a policy with no IOC list', (({ iocHosts: _i, ...rest }) => rest)(hubPolicy())],
    ])('refuses %s: an incomplete answer must not normalise to "off"', async (_label, partial) => {
      await seedHubRow(3, 'enforce');
      const { fetchImpl } = makeFetch(ok(partial, 6));
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('error');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(3);
      expect(row?.policy.mode).toBe('enforce');
    });

    it('adopts an IOC-only change at the same revision', async () => {
      await seedHubRow(3, 'enforce');
      const { fetchImpl } = makeFetch(ok(hubPolicy({}, 2, ['bad.example', 'worse.example']), 3, 2));
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('adopted');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(3);
      expect(row?.etag).toBe('W/"3:2"');
      expect(row?.policy.iocHosts.hosts).toEqual(['bad.example', 'worse.example']);
    });

    it('{policy: null} leaves the local policy effective, and read-only while joined', async () => {
      await storage.putAirlockPolicy({
        scope: 'local', revision: 1, policy: normalizeAirlockPolicy({ mode: 'observe' }),
        updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'me', authority: 'local',
      }, 0);
      const { fetchImpl } = makeFetch({ status: 200, body: { policy: null, revision: 0 }, etag: 'W/"0:0"' });
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('none');
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
      const view = await resolveAirlockPolicy(storage, true);
      expect(view.source).toBe('local');
      expect(view.effective.mode).toBe('observe');
      expect(view.hubManaged).toBe(true);
    });
  });

  describe('the stored row belongs to one authority', () => {
    it("repointed to another org at the same revision: org B is not offered org A's ETag, and its policy replaces A's", async () => {
      await seedHubRow(3, 'observe', HUB_A);
      const { fetchImpl, calls } = makeFetch(ok(hubPolicy({ mode: 'enforce', hosts: { allow: ['b.example'], deny: [] } }), 3));
      const out = await sync(fetchImpl, HUB_B);
      expect(calls[0].headers['If-None-Match']).toBeUndefined();
      expect(out.outcome).toBe('adopted');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.updatedBy).toBe(airlockAuthorityOf(HUB_B));
      expect(row?.policy.mode).toBe('enforce');
      expect(row?.policy.hosts.allow).toEqual(['b.example']);
    });

    it("an older revision from a different org still replaces the other org's row", async () => {
      await seedHubRow(9, 'observe', HUB_A);
      const { fetchImpl } = makeFetch(ok(hubPolicy({ mode: 'enforce' }), 2));
      expect((await sync(fetchImpl, HUB_B)).outcome).toBe('adopted');
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(2);
    });

    it("a new org with no policy drops the old org's row instead of keeping it in force", async () => {
      await seedHubRow(3, 'enforce', HUB_A);
      const { fetchImpl } = makeFetch({ status: 200, body: { policy: null, revision: 0 }, etag: 'W/"0:0"' });
      expect((await sync(fetchImpl, HUB_B)).outcome).toBe('none');
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
    });

    it('after logout and rejoin, no ETag is offered: nothing is stored to revalidate', async () => {
      await seedHubRow(3, 'enforce', HUB_A);
      await releaseHubAirlockPolicy({ storage, stateFile });
      const { fetchImpl, calls } = makeFetch(ok(hubPolicy(), 3));
      const out = await sync(fetchImpl, HUB_A);
      expect(calls[0].headers['If-None-Match']).toBeUndefined();
      expect(out.outcome).toBe('adopted');
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(3);
    });
  });

  describe('out-of-order answers never roll the protection back', () => {
    it.each<[string, number, number]>([
      ['an older policy revision', 4, 9],
      ['the same revision with an older IOC list', 5, 1],
    ])('refuses %s than the one stored', async (_label, revision, iocRevision) => {
      await seedHubRow(5, 'enforce', HUB_A, 2);
      const { fetchImpl } = makeFetch(ok(hubPolicy({ mode: 'off' }, iocRevision), revision, iocRevision));
      const out = await sync(fetchImpl);
      expect(out.outcome).toBe('stale');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(5);
      expect(row?.policy.mode).toBe('enforce');
    });

    it('a policy change: two syncs whose answers land in reverse order keep the newer one', async () => {
      const { fetchImpl, pending, started } = makeDeferredFetch();
      const first = sync(fetchImpl);
      const second = sync(fetchImpl);
      await started(2);
      pending[1](ok(hubPolicy({ mode: 'enforce' }), 6));
      expect((await second).outcome).toBe('adopted');
      pending[0](ok(hubPolicy({ mode: 'off' }), 5));
      expect((await first).outcome).toBe('stale');
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.revision).toBe(6);
      expect(row?.policy.mode).toBe('enforce');
    });

    it('an IOC-only change: the older IOC list landing last does not replace the newer', async () => {
      const { fetchImpl, pending, started } = makeDeferredFetch();
      const first = sync(fetchImpl);
      const second = sync(fetchImpl);
      await started(2);
      pending[1](ok(hubPolicy({}, 3, ['new.example']), 4, 3));
      await second;
      pending[0](ok(hubPolicy({}, 2, ['old.example']), 4, 2));
      expect((await first).outcome).toBe('stale');
      expect((await storage.getAirlockPolicy('hub'))?.policy.iocHosts.hosts).toEqual(['new.example']);
    });
  });

  describe('leaving the hub supersedes syncs in flight', () => {
    it('logout while a fetch is pending: the late answer does not resurrect hub ownership', async () => {
      await seedHubRow(3, 'enforce');
      const { fetchImpl, pending, started } = makeDeferredFetch();
      const inFlight = sync(fetchImpl);
      await started(1);
      await releaseHubAirlockPolicy({ storage, stateFile });
      pending[0](ok(hubPolicy({ mode: 'observe' }), 4));
      expect((await inFlight).outcome).toBe('superseded');
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
      expect((await storage.getAirlockPolicy('local'))?.policy.mode).toBe('enforce');
    });

    it('a configuration change (invalidateAirlockSyncs) supersedes a pending answer', async () => {
      const { fetchImpl, pending, started } = makeDeferredFetch();
      const inFlight = sync(fetchImpl);
      await started(1);
      invalidateAirlockSyncs();
      pending[0](ok(hubPolicy(), 4));
      expect((await inFlight).outcome).toBe('superseded');
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
    });

    it('an adoption racing a release ends with no hub row either way', async () => {
      await seedHubRow(3, 'observe');
      const { fetchImpl } = makeFetch(ok(hubPolicy({ mode: 'enforce' }), 4));
      await Promise.all([sync(fetchImpl), releaseHubAirlockPolicy({ storage, stateFile })]);
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
      expect(await storage.getAirlockPolicy('local')).not.toBeNull();
    });
  });

  describe('a tick that outlives its hub configuration', () => {
    /** The old tick's fetch: its project flow fetch waits for the spec; its Airlock fetch answers `airlock`. */
    function staleTickFetch(airlock: Answer) {
      let releaseFlow!: () => void;
      const flowHeld = new Promise<void>(r => { releaseFlow = r; });
      let flowStarted = false;
      const airlockCalls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/v1/flows/active')) {
          flowStarted = true;
          await flowHeld;
          return answer({ status: 200, body: { flow: null } });
        }
        if (url.includes('/v1/airlock/policy')) { airlockCalls.push(url); return answer(airlock); }
        return answer({ status: 404, body: {} });
      });
      const waitForFlow = async () => { while (!flowStarted) await new Promise(r => setTimeout(r, 1)); };
      return { fetchImpl: fetchImpl as any, releaseFlow, waitForFlow, airlockCalls };
    }

    it("repointed to org B mid-tick: the old tick does not replace B's policy with A's", async () => {
      await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
      const old = staleTickFetch(ok(hubPolicy({ mode: 'off' }), 50));
      const tick = runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl: old.fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
      await old.waitForFlow();

      invalidateAirlockSyncs(); // the repoint
      const b = makeFetch(ok(hubPolicy({ mode: 'enforce', hosts: { allow: ['b.example'], deny: [] } }), 2));
      expect((await sync(b.fetchImpl, HUB_B)).outcome).toBe('adopted');

      old.releaseFlow();
      await tick;
      expect(old.airlockCalls).toHaveLength(0);
      const row = await storage.getAirlockPolicy('hub');
      expect(row?.updatedBy).toBe(airlockAuthorityOf(HUB_B));
      expect(row?.policy.mode).toBe('enforce');
    });

    it('logged out mid-tick: no hub row reappears and the policy stays editable locally', async () => {
      await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
      await seedHubRow(3, 'enforce');
      const old = staleTickFetch(ok(hubPolicy({ mode: 'off' }), 50));
      const tick = runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl: old.fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
      await old.waitForFlow();

      await releaseHubAirlockPolicy({ storage, stateFile }); // the logout

      old.releaseFlow();
      await tick;
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
      const view = await resolveAirlockPolicy(storage, false);
      expect(view.hubManaged).toBe(false);
      expect(view.effective.mode).toBe('enforce');
    });

    it('a sync told the active hub is another authority writes nothing', async () => {
      const { fetchImpl } = makeFetch(ok(hubPolicy({ mode: 'off' }), 5));
      const out = await syncAirlockPolicy({ storage, hubConfig: HUB_A, fetchImpl, stateFile, activeHubConfig: () => HUB_B });
      expect(out.outcome).toBe('superseded');
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
    });
  });

  describe('runFlowSyncTick', () => {
    async function mkProject(id: string) {
      await storage.createProject({ id, name: id, description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    }

    it('syncs Airlock once per tick, not once per project, and revalidates with the stored ETag', async () => {
      await mkProject('p1');
      await mkProject('p2');
      await mkProject('p3');
      const { fetchImpl, calls } = makeFetch(ok(hubPolicy(), 2));
      await runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
      expect(calls.filter(c => c.url.includes('/v1/airlock/policy'))).toHaveLength(1);
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(2);

      const second = makeFetch({ status: 304 });
      await runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl: second.fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
      const asked = second.calls.filter(c => c.url.includes('/v1/airlock/policy'));
      expect(asked).toHaveLength(1);
      expect(asked[0].headers['If-None-Match']).toBe('W/"2:1"');
    });

    it('syncs Airlock even with no projects (it is org-scoped)', async () => {
      const { fetchImpl, calls } = makeFetch(ok(hubPolicy(), 2));
      await runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
      expect(calls.filter(c => c.url.includes('/v1/airlock/policy'))).toHaveLength(1);
      expect(calls.filter(c => c.url.includes('/v1/flows/active'))).toHaveLength(0);
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(2);
    });

    it('a throw in the Airlock sync neither fails the tick nor stops receipts', async () => {
      await mkProject('p1');
      vi.spyOn(storage, 'putAirlockPolicy').mockRejectedValue(new Error('disk full'));
      const listItems = vi.spyOn(storage, 'listItems');
      const { fetchImpl } = makeFetch(ok(hubPolicy(), 2));
      await expect(runFlowSyncTick({ storage, hubConfig: HUB_A, fetchImpl, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile }))
        .resolves.toBeUndefined();
      expect(listItems).toHaveBeenCalled();
    });
  });

  describe('releaseHubAirlockPolicy (leaving the hub)', () => {
    it('copies the hub row to local and drops the hub row, so the policy stays in force and editable', async () => {
      await seedHubRow(7, 'enforce');
      const out = await releaseHubAirlockPolicy({ storage, stateFile });
      expect(out.released).toBe(true);
      expect(await storage.getAirlockPolicy('hub')).toBeNull();
      const local = await storage.getAirlockPolicy('local');
      expect(local?.policy.mode).toBe('enforce');
      expect(local?.policy.hosts.allow).toEqual(['github.com']);
      expect(local?.authority).toBe('local');
      const view = await resolveAirlockPolicy(storage, false);
      expect(view.source).toBe('local');
      expect(view.hubManaged).toBe(false);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.mode).toBe('enforce');
      expect(state.source).toBe('local');
    });

    it('replaces an older local row at its next revision', async () => {
      await storage.putAirlockPolicy({
        scope: 'local', revision: 2, policy: normalizeAirlockPolicy({ mode: 'off' }),
        updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'me', authority: 'local',
      }, 0);
      await seedHubRow(7, 'enforce');
      await releaseHubAirlockPolicy({ storage, stateFile });
      const local = await storage.getAirlockPolicy('local');
      expect(local?.revision).toBe(3);
      expect(local?.policy.mode).toBe('enforce');
    });

    it('does nothing when there is no hub row', async () => {
      const out = await releaseHubAirlockPolicy({ storage, stateFile });
      expect(out.released).toBe(false);
      expect(await storage.getAirlockPolicy('local')).toBeNull();
    });
  });
});
