/**
 * Tests for the per-project flowSync reconciler.
 *
 * The hub now resolves an effective flow per (org, project, installation)
 * triple. The client iterates its local projects and polls the hub once per
 * project, caching the per-project ETag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { reconcileProjectFlow, runFlowSyncTick } from '../hub/flowSync';

const baseSteps = [
  { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
  { id: 's1', name: 'work', label: 'Work', order: 1 },
  { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
];

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';

interface FakeResponse { status: number; etag?: string; body?: any }

function makeFetchByProject(map: Record<string, FakeResponse>) {
  return vi.fn(async (url: string, _opts: any) => {
    const u = new URL(url);
    const pid = u.searchParams.get('projectId') ?? '__noproject__';
    const r = map[pid] ?? { status: 200, body: { flow: null } };
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

describe('reconcileProjectFlow + per-project polling', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flow-sync-mp-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    emit = vi.fn();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('binds each project to its effective flow', async () => {
    const p1 = await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    const p2 = await storage.createProject({ id: 'p2', name: 'p2', description: '', createdAt: new Date(), updatedAt: new Date() } as any);

    const fetchImpl = makeFetchByProject({
      p1: { status: 200, etag: 'W/"1:project:p1"', body: { flow: { id: 'remote-A', name: 'A', steps: baseSteps }, hubVersion: 1, scope: 'project', targetId: 'p1' } },
      p2: { status: 200, etag: 'W/"1:project:p2"', body: { flow: { id: 'remote-B', name: 'B', steps: baseSteps }, hubVersion: 1, scope: 'project', targetId: 'p2' } },
    });

    const etagCache = new Map<string, string>();
    await runFlowSyncTick({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl, emit, etagCache });

    const flows = await storage.listFlows();
    expect(flows).toHaveLength(2);
    const flowsByHubId = Object.fromEntries(flows.map(f => [f.hubFlowId, f]));
    expect(flowsByHubId['remote-A']).toBeTruthy();
    expect(flowsByHubId['remote-B']).toBeTruthy();

    const projP1 = await storage.getProject(p1.id);
    const projP2 = await storage.getProject(p2.id);
    expect(projP1?.flowId).toBe(flowsByHubId['remote-A'].id);
    expect(projP2?.flowId).toBe(flowsByHubId['remote-B'].id);
    expect(emit).toHaveBeenCalled();
  });

  it('per-project ETag cache: 304 on stable project, 200 on changed', async () => {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createProject({ id: 'p2', name: 'p2', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    const etagCache = new Map<string, string>();

    // First tick — both projects fetch with 200 + ETag.
    const fetch1 = makeFetchByProject({
      p1: { status: 200, etag: 'W/"1:project:p1"', body: { flow: { id: 'remote-A', name: 'A', steps: baseSteps }, hubVersion: 1, scope: 'project', targetId: 'p1' } },
      p2: { status: 200, etag: 'W/"1:project:p2"', body: { flow: { id: 'remote-B', name: 'B', steps: baseSteps }, hubVersion: 1, scope: 'project', targetId: 'p2' } },
    });
    await runFlowSyncTick({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl: fetch1, emit, etagCache });
    expect(etagCache.size).toBe(2);

    // Second tick — p1 returns 304, p2 returns 200 with bumped version.
    const fetch2 = makeFetchByProject({
      p1: { status: 304 },
      p2: { status: 200, etag: 'W/"2:project:p2"', body: { flow: { id: 'remote-B', name: 'B v2', steps: baseSteps }, hubVersion: 2, scope: 'project', targetId: 'p2' } },
    });
    await runFlowSyncTick({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl: fetch2, emit, etagCache });

    // Verify If-None-Match was sent for p1 (matching cached value).
    const p1Call = (fetch2 as any).mock.calls.find((c: any[]) => c[0].includes('projectId=p1'));
    expect(p1Call[1].headers['If-None-Match']).toBe('W/"1:project:p1"');

    const flows = await storage.listFlows();
    const b = flows.find(f => f.hubFlowId === 'remote-B');
    expect(b?.name).toBe('B v2');
    expect(b?.hubVersion).toBe(2);
  });

  it('empty project list → no fetches', async () => {
    const fetchImpl = vi.fn();
    const etagCache = new Map<string, string>();
    await runFlowSyncTick({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl, emit, etagCache });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('per-project failure does not break other projects', async () => {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    await storage.createProject({ id: 'p2', name: 'p2', description: '', createdAt: new Date(), updatedAt: new Date() } as any);

    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls++;
      if (url.includes('projectId=p1')) throw new Error('boom');
      return {
        status: 200, ok: true,
        headers: { get: () => 'W/"1:project:p2"' },
        json: async () => ({ flow: { id: 'remote-B', name: 'B', steps: baseSteps }, hubVersion: 1, scope: 'project', targetId: 'p2' }),
      } as any;
    });

    const etagCache = new Map<string, string>();
    await runFlowSyncTick({ storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG }, fetchImpl, emit, etagCache });

    expect(calls).toBe(2);
    const flows = await storage.listFlows();
    expect(flows.find(f => f.hubFlowId === 'remote-B')).toBeTruthy();
  });

  it('reconcileProjectFlow no-assignment outcome leaves storage alone', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      json: async () => ({ flow: null }),
    } as any));

    const result = await reconcileProjectFlow({
      storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      projectId: 'p1', lastEtag: null, fetchImpl, emit,
    });
    expect(result.outcome).toBe('no-assignment');
    expect((await storage.listFlows()).length).toBe(0);
  });

  it('reconcileProjectFlow appends projectId to URL', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) } as any));
    await reconcileProjectFlow({
      storage, hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      projectId: 'my-project', lastEtag: 'W/"old"', fetchImpl, emit,
    });
    const calledUrl = (fetchImpl as any).mock.calls[0][0];
    expect(calledUrl).toContain('/v1/flows/active');
    expect(calledUrl).toContain('projectId=my-project');
  });
});
