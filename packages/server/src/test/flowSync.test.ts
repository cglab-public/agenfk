/**
 * Unit tests for the client-side flowSync reconciler.
 *
 * The reconciler periodically pulls the org's hub-managed flow from the corp
 * Hub's `/v1/flows/active` endpoint and reconciles it into local storage with
 * `source = 'hub'`. We drive it with a fake fetch + a real SQLiteStorageProvider
 * (file-backed, isolated per test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { reconcileHubFlow } from '../hub/flowSync';

const baseSteps = [
  { id: 's0', name: 'todo',  label: 'Todo',   order: 0, isAnchor: true },
  { id: 's1', name: 'work',  label: 'Work',   order: 1 },
  { id: 's2', name: 'done',  label: 'Done',   order: 2, isAnchor: true },
];

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';

function makeFetchSequence(seq: Array<{ status: number; body?: any; etag?: string }>) {
  let i = 0;
  return vi.fn(async (_url: string, _opts: any) => {
    const r = seq[Math.min(i, seq.length - 1)];
    i++;
    const headers: Record<string, string> = {};
    if (r.etag) headers['etag'] = r.etag;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    } as any;
  });
}

describe('flowSync.reconcileHubFlow', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flow-sync-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    emit = vi.fn();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('200 with new hub flow → upserts local row with source=hub and emits flow:updated', async () => {
    const remoteFlow = { id: 'remote-1', name: 'Org Flow', description: '', steps: baseSteps };
    const fetchImpl = makeFetchSequence([
      { status: 200, etag: 'W/"3"', body: { flow: remoteFlow, hubVersion: 3 } },
    ]);

    const project = await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);

    const result = await reconcileHubFlow({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      lastEtag: null,
      fetchImpl,
      emit,
    });

    expect(result.outcome).toBe('updated');
    expect(result.etag).toBe('W/"3"');
    const flows = await storage.listFlows();
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.source).toBe('hub');
    expect(f.hubFlowId).toBe('remote-1');
    expect(f.hubVersion).toBe(3);
    expect(f.name).toBe('Org Flow');
    // Project re-bound to the local hub flow.
    const proj = await storage.getProject(project.id);
    expect(proj?.flowId).toBe(f.id);
    expect(emit).toHaveBeenCalledWith('flow:updated', expect.objectContaining({ flowId: f.id }));
  });

  it('304 with matching ETag → no-op', async () => {
    const fetchImpl = makeFetchSequence([{ status: 304 }]);
    const result = await reconcileHubFlow({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      lastEtag: 'W/"3"',
      fetchImpl,
      emit,
    });
    expect(result.outcome).toBe('not-modified');
    expect((await storage.listFlows()).length).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('200 with same hub id but bumped version → updates existing row, keeps stable local id', async () => {
    const fetch1 = makeFetchSequence([
      { status: 200, etag: 'W/"1"', body: { flow: { id: 'remote-x', name: 'V1', description: '', steps: baseSteps }, hubVersion: 1 } },
    ]);
    const r1 = await reconcileHubFlow({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, lastEtag: null, fetchImpl: fetch1, emit });
    const localId = (await storage.listFlows())[0].id;
    expect(r1.outcome).toBe('updated');

    const fetch2 = makeFetchSequence([
      { status: 200, etag: 'W/"2"', body: { flow: { id: 'remote-x', name: 'V2', description: '', steps: baseSteps }, hubVersion: 2 } },
    ]);
    await reconcileHubFlow({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, lastEtag: 'W/"1"', fetchImpl: fetch2, emit });
    const flows = await storage.listFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0].id).toBe(localId); // stable across versions
    expect(flows[0].hubVersion).toBe(2);
    expect(flows[0].name).toBe('V2');
  });

  it('200 with { flow: null } → leaves existing local hub flow alone', async () => {
    // Seed an existing hub-managed flow.
    await storage.createFlow({
      id: 'local-hub-id',
      name: 'cached',
      description: '',
      version: '1',
      steps: baseSteps,
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'hub',
      hubFlowId: 'remote-cached',
      hubVersion: 5,
    } as any);
    const fetchImpl = makeFetchSequence([{ status: 200, body: { flow: null } }]);
    const result = await reconcileHubFlow({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, lastEtag: null, fetchImpl, emit });
    expect(result.outcome).toBe('no-assignment');
    expect((await storage.listFlows())).toHaveLength(1); // still there
  });

  it('transport failure → returns error outcome and does not crash', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await reconcileHubFlow({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, lastEtag: null, fetchImpl, emit });
    expect(result.outcome).toBe('error');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('401 → returns error outcome (caller should stop polling, but reconciler does not throw)', async () => {
    const fetchImpl = makeFetchSequence([{ status: 401, body: { error: 'Invalid or revoked token' } }]);
    const result = await reconcileHubFlow({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, lastEtag: null, fetchImpl, emit });
    expect(result.outcome).toBe('error');
  });

  it('passes Authorization header and If-None-Match to fetch', async () => {
    const fetchImpl = makeFetchSequence([{ status: 304 }]);
    await reconcileHubFlow({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      lastEtag: 'W/"7"',
      fetchImpl,
      emit,
    });
    const callArgs = (fetchImpl as any).mock.calls[0];
    expect(callArgs[0]).toBe(`${HUB_URL}/v1/flows/active`);
    expect(callArgs[1].headers['Authorization']).toBe(`Bearer ${HUB_TOKEN}`);
    expect(callArgs[1].headers['If-None-Match']).toBe('W/"7"');
  });
});
