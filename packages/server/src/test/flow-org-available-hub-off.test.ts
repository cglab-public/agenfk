/**
 * Deterministic end-to-end tests for the two org-flow routes with the corp Hub
 * *disabled* (no AGENFK_HUB_URL/TOKEN/ORG).
 *
 * Mirrors flow-refresh-route-hub-on.test.ts harness structure, but hub env
 * vars are explicitly deleted so loadHubConfig() returns null. A benign fetch
 * stub is still set so any stray background call does not hit the network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';

const TEST_DB = path.resolve('./flow-org-avail-huboff-test-db.sqlite');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any;

// Benign stub — returns 204 for everything so no live network is hit.
function stubBenignFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => {
    return { status: 204, ok: true, headers: { get: () => null }, json: async () => ({}) } as any;
  }));
}

describe('org-flow routes (hub disabled)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Explicitly remove hub config so loadHubConfig() returns null.
    delete process.env.AGENFK_HUB_URL;
    delete process.env.AGENFK_HUB_TOKEN;
    delete process.env.AGENFK_HUB_ORG;
    process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS = '3600000';
    process.env.AGENFK_DB_PATH = TEST_DB;
    stubBenignFetch(); // stub before import so any startup fetch is intercepted
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
    stubBenignFetch(); // resetMocks clears the impl between tests; re-stub
  });

  it('GET /flows/org-available reports hub disabled', async () => {
    const r = await request(app).get('/flows/org-available');
    expect(r.status).toBe(200);
    expect(r.body.hubEnabled).toBe(false);
    expect(r.body.flows).toEqual([]);
  });

  it('select-org without a hub configured → 400', async () => {
    const project = (await request(app).post('/projects').send({ name: 'p' })).body;
    const r = await request(app)
      .post(`/projects/${project.id}/flow/select-org`)
      .send({ flowId: 'x' });
    expect(r.status).toBe(400);
  });
});