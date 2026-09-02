/**
 * Deterministic end-to-end test of GET /projects/:id/flow?refresh=true with the
 * corp Hub *enabled*.
 *
 * We force hub config via env BEFORE importing the server module (hubClient
 * captures config at import), and stub global fetch so the "hub" is a controlled
 * fake — no live network. This exercises the route → refreshProjectFlowFromHub →
 * reconcile → rebind path that the hub-disabled route tests can't reach.
 *
 * Env is saved/restored so hub config doesn't leak into other test files
 * (process.env is shared across the worker even though modules are isolated).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';

const TEST_DB = path.resolve('./flow-refresh-hubon-test-db.sqlite');
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

// Fake hub: return a managed flow for /v1/flows/active, benign for everything
// else (outbox flush, upgrade directive) so background timers never error.
function stubHubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/v1/flows/active')) {
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

const localSteps = [
  { id: 's1', name: 'TODO', label: 'TODO', order: 1, isAnchor: true },
  { id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
];

describe('GET /projects/:id/flow?refresh=true (hub enabled)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = 'http://hub.example.test';
    process.env.AGENFK_HUB_TOKEN = 'agk_test';
    process.env.AGENFK_HUB_ORG = 'org-test';
    // Keep the 5-min poller from firing during the test window.
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
    stubHubFetch(); // re-stub below clears the previous impl (no implicit reset)
  });

  it('pulls the hub flow and rebinds the project on read, and it persists', async () => {
    const local = (await request(app).post('/flows').send({ name: 'LocalFlow', steps: localSteps })).body;
    const project = (await request(app).post('/projects').send({ name: 'proj' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: local.id });

    const r = await request(app).get(`/projects/${project.id}/flow?refresh=true`);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Hub Managed Flow');
    expect(r.body.source).toBe('hub');

    // A subsequent plain read reflects the rebind — the refresh persisted.
    const plain = await request(app).get(`/projects/${project.id}/flow`);
    expect(plain.body.name).toBe('Hub Managed Flow');
  });

  it('without ?refresh the local flow is returned (no hub pull)', async () => {
    const local = (await request(app).post('/flows').send({ name: 'LocalOnly', steps: localSteps })).body;
    const project = (await request(app).post('/projects').send({ name: 'proj2' })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: local.id });

    const r = await request(app).get(`/projects/${project.id}/flow`);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('LocalOnly');
  });
});
