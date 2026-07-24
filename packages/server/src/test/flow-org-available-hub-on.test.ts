/**
 * Deterministic end-to-end tests for the two org-flow routes with the corp Hub
 * *enabled*:
 *   GET  /flows/org-available
 *   POST /projects/:id/flow/select-org
 *
 * Hub config is forced via env BEFORE importing the server module (hubClient
 * captures config at import), and global fetch is stubbed so no live network is
 * hit. Env is saved/restored so nothing leaks to other test files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';

const TEST_DB = path.resolve('./flow-org-avail-hubon-test-db.sqlite');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any;

const hubSteps = [
  { id: 'h1', name: 'BACKLOG', label: 'Backlog', order: 0, isAnchor: true },
  { id: 'h2', name: 'DOING', label: 'Doing', order: 1 },
  { id: 'h3', name: 'SHIPPED', label: 'Shipped', order: 2, isAnchor: true },
];

// Mutable per-test controls for the stub responses
let selectionStatus = 200;
let activeMode: 'ok' | 'error' = 'ok';

// Fake hub: respond correctly to /v1/flows/available, /v1/flows/selection,
// /v1/flows/active, and return a benign 204 for everything else.
function stubHubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const urlString = String(url);

    if (urlString.includes('/v1/flows/available')) {
      return {
        status: 200, ok: true,
        headers: { get: () => null },
        json: async () => ({
          flows: [
            {
              id: 'hub-remote-1',
              name: 'Hub Managed Flow',
              description: '',
              steps: hubSteps,
              isDefault: true,
            },
          ],
          defaultFlowId: 'hub-remote-1',
        }),
      } as any;
    }

    if (urlString.includes('/v1/flows/selection')) {
      return {
        status: selectionStatus, ok: selectionStatus < 400,
        headers: { get: () => null },
        json: async () =>
          selectionStatus < 400
            ? { projectId: 'x', flowId: 'hub-remote-1', scope: 'project' }
            : { error: 'nope' },
      } as any;
    }

    if (urlString.includes('/v1/flows/active')) {
      if (activeMode === 'error') {
        return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) } as any;
      }
      return {
        status: 200, ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? 'W/"hub-1"' : null) },
        json: async () => ({
          flow: { id: 'hub-remote-1', name: 'Hub Managed Flow', description: '', steps: hubSteps },
          hubVersion: 1,
        }),
      } as any;
    }

    return { status: 204, ok: true, headers: { get: () => null }, json: async () => ({}) } as any;
  }));
}

describe('org-flow routes (hub enabled)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = 'http://hub.example.test';
    process.env.AGENFK_HUB_TOKEN = 'agk_test';
    process.env.AGENFK_HUB_ORG = 'org-test';
    process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS = '3600000';
    process.env.AGENFK_DB_PATH = TEST_DB;
    stubHubFetch(); // stub before import so any startup fetch is intercepted
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    ({ app, initStorage } = await import('../server'));
    await initStorage();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  beforeEach(async () => {
    selectionStatus = 200;
    activeMode = 'ok';
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    stubHubFetch(); // resetMocks clears the impl between tests; re-stub
  });

  it('GET /flows/org-available returns the hub available set', async () => {
    const r = await request(app).get('/flows/org-available');
    expect(r.status).toBe(200);
    expect(r.body.hubEnabled).toBe(true);
    expect(r.body.flows).toHaveLength(1);
    expect(r.body.flows[0].id).toBe('hub-remote-1');
    expect(r.body.defaultFlowId).toBe('hub-remote-1');
  });

  it('POST select-org selects a flow and rebinds the project', async () => {
    const project = (await request(app).post('/projects').send({ name: 'p' })).body;

    const r = await request(app)
      .post(`/projects/${project.id}/flow/select-org`)
      .send({ flowId: 'hub-remote-1' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Hub Managed Flow');
    expect(r.body.source).toBe('hub');

    // Rebind persisted — plain GET reflects the hub flow
    const plain = await request(app).get(`/projects/${project.id}/flow`);
    expect(plain.body.name).toBe('Hub Managed Flow');
  });

  it('select-org on a missing project → 404', async () => {
    const r = await request(app)
      .post('/projects/does-not-exist/flow/select-org')
      .send({ flowId: 'hub-remote-1' });
    expect(r.status).toBe(404);
  });

  it('select-org without flowId → 400', async () => {
    const project = (await request(app).post('/projects').send({ name: 'p2' })).body;
    const r = await request(app)
      .post(`/projects/${project.id}/flow/select-org`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('migrates in-flight cards when the selected flow changes step names', async () => {
    // project on a LOCAL flow whose steps differ from the hub flow (BACKLOG/DOING/SHIPPED)
    const local = (await request(app).post('/flows').send({ name: 'LocalFlow', steps: [
      { id: 'l1', name: 'TODO', label: 'Todo', order: 0, isAnchor: true },
      { id: 'l2', name: 'DOING', label: 'Doing', order: 1 },
      { id: 'l3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ] })).body;
    const project = (await request(app).post('/projects').send({ name: 'pm' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: local.id });
    // seed an item on a status that does NOT exist in the hub flow's steps
    await request(app).post('/items').send({ type: 'TASK', title: 't', projectId: project.id });

    const r = await request(app).post(`/projects/${project.id}/flow/select-org`).send({ flowId: 'hub-remote-1' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Hub Managed Flow');
    // every item must now be on a status that exists in the hub flow's steps
    const items = (await request(app).get(`/items?projectId=${project.id}`)).body;
    const validStatuses = ['BACKLOG', 'DOING', 'SHIPPED'];
    for (const it of items) expect(validStatuses).toContain(it.status);
  });

  it('clearing the selection (flowId null) unbinds the project locally', async () => {
    const local = (await request(app).post('/flows').send({ name: 'LocalOnly', steps: [
      { id: 'l1', name: 'TODO', label: 'Todo', order: 0, isAnchor: true },
      { id: 'l2', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
    ] })).body;
    const project = (await request(app).post('/projects').send({ name: 'pc' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: local.id });
    const r = await request(app).post(`/projects/${project.id}/flow/select-org`).send({ flowId: null });
    expect(r.status).toBe(200);
    // project no longer bound to the local flow -> plain flow read returns the built-in default
    const flow = (await request(app).get(`/projects/${project.id}/flow`)).body;
    expect(flow.name).not.toBe('LocalOnly');
  });

  it('clearing the selection migrates in-flight cards off the old flow to the default flow', async () => {
    // Local flow with a custom status that the built-in DEFAULT_FLOW lacks.
    const local = (await request(app).post('/flows').send({ name: 'CustomClear', steps: [
      { id: 'l1', name: 'TODO', label: 'Todo', order: 0, isAnchor: true },
      { id: 'l2', name: 'CUSTOMSTAGE', label: 'Custom', order: 1 },
      { id: 'l3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ] })).body;
    const project = (await request(app).post('/projects').send({ name: 'pcmig' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: local.id });
    // Park an item on the custom status that won't exist after clearing to default.
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 't', projectId: project.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'CUSTOMSTAGE' });

    const r = await request(app).post(`/projects/${project.id}/flow/select-org`).send({ flowId: null });
    expect(r.status).toBe(200);
    // No item may be left orphaned on a status the default flow doesn't define.
    const defaultStatuses = (r.body.steps as any[]).map((s) => s.name);
    const items = (await request(app).get(`/items?projectId=${project.id}`)).body;
    for (const it of items) expect(defaultStatuses).toContain(it.status);
  });

  it('returns 502 when the hub selection succeeds but the local reconcile fails', async () => {
    activeMode = 'error'; // /v1/flows/active returns 500 during reconcile
    const project = (await request(app).post('/projects').send({ name: 'pf' })).body;
    const r = await request(app).post(`/projects/${project.id}/flow/select-org`).send({ flowId: 'hub-remote-1' });
    expect(r.status).toBe(502);
    expect(r.body.reconciled).toBe(false);
  });

  it('passes through a hub 401 as 401 (re-auth needed, not 502)', async () => {
    selectionStatus = 401;
    const project = (await request(app).post('/projects').send({ name: 'p401' })).body;
    const r = await request(app).post(`/projects/${project.id}/flow/select-org`).send({ flowId: 'hub-remote-1' });
    expect(r.status).toBe(401);
  });
});