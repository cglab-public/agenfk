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
        status: 200, ok: true,
        headers: { get: () => null },
        json: async () => ({
          projectId: 'ignored',
          flowId: 'hub-remote-1',
          scope: 'project',
        }),
      } as any;
    }

    if (urlString.includes('/v1/flows/active')) {
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
});