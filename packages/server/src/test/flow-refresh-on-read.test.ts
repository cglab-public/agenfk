/**
 * Tests for on-demand hub flow refresh on read.
 *
 * `agenfk flow show` should reflect a hub-side "Use this flow" change without
 * waiting for the 5-minute poll. The server does this by attempting an
 * ETag-aware reconcile against the corp Hub when a read asks for it
 * (`GET /projects/:id/flow?refresh=true`), and — crucially — falling back
 * silently to the local flow on ANY hub error.
 *
 * We test the injectable helper directly (fake fetch + real SQLite storage,
 * mirroring flowSync.test.ts), plus the route behaviour when the hub is not
 * configured (the common case) to prove `?refresh=true` never breaks a read.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import request from 'supertest';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { refreshProjectFlowFromHub } from '../hub/flowRefresh';
import { reconcileProjectFlow } from '../hub/flowSync';

const baseSteps = [
  { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
  { id: 's1', name: 'work', label: 'Work', order: 1 },
  { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
];

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';
const hubConfig = { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG };

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

describe('refreshProjectFlowFromHub', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let emit: ReturnType<typeof vi.fn>;
  let etagCache: Map<string, string>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flow-refresh-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    emit = vi.fn();
    etagCache = new Map();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('is a no-op when the hub is disabled (never calls fetch)', async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: { flow: { id: 'r', name: 'X', steps: baseSteps } } }]);
    await refreshProjectFlowFromHub({
      storage, hubEnabled: false, hubConfig, projectId: 'p1', fetchImpl, emit, etagCache,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect((await storage.listFlows())).toHaveLength(0);
  });

  it('is a no-op when hubConfig is null', async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: { flow: { id: 'r', name: 'X', steps: baseSteps } } }]);
    await refreshProjectFlowFromHub({
      storage, hubEnabled: true, hubConfig: null, projectId: 'p1', fetchImpl, emit, etagCache,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await storage.listFlows())).toHaveLength(0);
  });

  it('pulls a changed hub flow into local storage and rebinds the project', async () => {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    const fetchImpl = makeFetchSequence([
      { status: 200, etag: 'W/"9"', body: { flow: { id: 'remote-9', name: 'New Org Flow', description: '', steps: baseSteps }, hubVersion: 9 } },
    ]);

    await refreshProjectFlowFromHub({
      storage, hubEnabled: true, hubConfig, projectId: 'p1', fetchImpl, emit, etagCache,
    });

    const flows = await storage.listFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0].source).toBe('hub');
    expect(flows[0].name).toBe('New Org Flow');
    const proj = await storage.getProject('p1');
    expect(proj?.flowId).toBe(flows[0].id);
    // ETag is cached so the next refresh can send If-None-Match.
    expect(etagCache.get('p1')).toBe('W/"9"');
    expect(emit).toHaveBeenCalledWith('flow:updated', expect.objectContaining({ flowId: flows[0].id, projectId: 'p1' }));
  });

  it('sends If-None-Match from the shared cache and no-ops on 304', async () => {
    etagCache.set('p1', 'W/"9"');
    const fetchImpl = makeFetchSequence([{ status: 304 }]);
    await refreshProjectFlowFromHub({
      storage, hubEnabled: true, hubConfig, projectId: 'p1', fetchImpl, emit, etagCache,
    });
    expect((fetchImpl as any).mock.calls[0][1].headers['If-None-Match']).toBe('W/"9"');
    expect((await storage.listFlows())).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    // ETag preserved.
    expect(etagCache.get('p1')).toBe('W/"9"');
  });

  it('falls back silently on a hub transport error (does not throw, leaves local state intact)', async () => {
    // Seed an existing local hub flow bound to the project.
    await storage.createFlow({
      id: 'local-existing', name: 'cached', description: '', version: '1', steps: baseSteps,
      createdAt: new Date(), updatedAt: new Date(), source: 'hub', hubFlowId: 'remote-cached', hubVersion: 5,
    } as any);
    await storage.createProject({ id: 'p1', name: 'p1', description: '', flowId: 'local-existing', createdAt: new Date(), updatedAt: new Date() } as any);

    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    // Resolves (never throws) with an 'error' reconcile outcome; local state below stays intact.
    await expect(refreshProjectFlowFromHub({
      storage, hubEnabled: true, hubConfig, projectId: 'p1', fetchImpl, emit, etagCache,
    })).resolves.toMatchObject({ outcome: 'error' });

    // Local flow and binding untouched — the read will fall back to this.
    const proj = await storage.getProject('p1');
    expect(proj?.flowId).toBe('local-existing');
    expect((await storage.listFlows())).toHaveLength(1);
  });

  it('falls back silently on an HTTP error status (401)', async () => {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    const fetchImpl = makeFetchSequence([{ status: 401, body: { error: 'revoked' } }]);
    // Resolves (never throws) with an 'error' reconcile outcome; no flow is created.
    await expect(refreshProjectFlowFromHub({
      storage, hubEnabled: true, hubConfig, projectId: 'p1', fetchImpl, emit, etagCache,
    })).resolves.toMatchObject({ outcome: 'error' });
    expect((await storage.listFlows())).toHaveLength(0);
  });

  // Regression for the concurrency hazard introduced by having two callers
  // (poll + on-demand refresh) drive reconcileProjectFlow: the read-modify-write
  // must be serialized per project so it can't mint duplicate rows for one hub id.
  it('serializes concurrent reconciles for the same project → exactly one row per hub flow', async () => {
    await storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    const remote = { id: 'remote-dup', name: 'Org', description: '', steps: baseSteps };
    // makeFetchSequence repeats its last entry, so every concurrent call gets 200.
    const fetchImpl = makeFetchSequence([{ status: 200, etag: 'W/"1"', body: { flow: remote, hubVersion: 1 } }]);

    await Promise.all([
      reconcileProjectFlow({ storage, hubConfig, projectId: 'p1', lastEtag: null, fetchImpl, emit }),
      reconcileProjectFlow({ storage, hubConfig, projectId: 'p1', lastEtag: null, fetchImpl, emit }),
      reconcileProjectFlow({ storage, hubConfig, projectId: 'p1', lastEtag: null, fetchImpl, emit }),
    ]);

    const dupes = (await storage.listFlows()).filter((f) => f.hubFlowId === 'remote-dup');
    expect(dupes).toHaveLength(1);
    const proj = await storage.getProject('p1');
    expect(proj?.flowId).toBe(dupes[0].id);
  });
});

describe('GET /projects/:id/flow?refresh=true (route wiring)', () => {
  const TEST_DB = path.resolve('./flow-refresh-route-test-db.sqlite');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any, initStorage: any;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    ({ app, initStorage } = await import('../server'));
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    // Whether or not the corp Hub is configured on this machine, keep the route
    // hermetic: stub fetch so a refresh never makes a live network call. The
    // exact reconcile semantics are covered by the helper unit tests above.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 304,
      ok: false,
      headers: { get: () => null },
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const steps = [
    { id: 's1', name: 'TODO', label: 'TODO', order: 1, isAnchor: true },
    { id: 's2', name: 'WORK', label: 'Work', order: 2 },
    { id: 's3', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
  ];

  it('plain read (no refresh) returns the project local flow', async () => {
    const flow = (await request(app).post('/flows').send({ name: 'LocalFlow', steps })).body;
    const project = (await request(app).post('/projects').send({ name: 'proj' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: flow.id });

    const r = await request(app).get(`/projects/${project.id}/flow`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(flow.id);
    expect(r.body.name).toBe('LocalFlow');
  });

  it('?refresh=true returns a valid flow (hub 304/off → local flow preserved)', async () => {
    const flow = (await request(app).post('/flows').send({ name: 'LocalFlow', steps })).body;
    const project = (await request(app).post('/projects').send({ name: 'proj' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: flow.id });

    const r = await request(app).get(`/projects/${project.id}/flow?refresh=true`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    // A 304 (or hub-off) refresh must not disturb the local binding.
    expect(r.body.id).toBe(flow.id);
  });

  it('?refresh=true on a project with no flow still returns a valid default flow', async () => {
    const project = (await request(app).post('/projects').send({ name: 'proj2' })).body;
    const r = await request(app).get(`/projects/${project.id}/flow?refresh=true`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps.length).toBeGreaterThan(0);
  });
});
