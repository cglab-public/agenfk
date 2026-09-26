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
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

// Mockable homedir (item 9c297075): pointing the SERVER at TMP_HOME via a
// call-time os.homedir() mock works under any runner (an env override only
// works while libuv follows the JS env — not under Stryker's threads pool,
// where this test would otherwise let loadHubConfig() read the real hub.json).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

const TEST_DB = path.resolve('./flow-org-avail-huboff-test-db.sqlite');
const TMP_HOME = path.join(os.tmpdir(), 'agenfk-huboff-home');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME', 'USERPROFILE',
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any;
let __server: any;
const agent = () => request(__server);

// Benign stub — returns 204 for everything so no live network is hit.
function stubBenignFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => {
    return { status: 204, ok: true, headers: { get: () => null }, json: async () => ({}) } as any;
  }));
}

describe('org-flow routes (hub disabled)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Redirect homedir so loadHubConfig() does NOT find ~/.agenfk/hub.json.
    fs.mkdirSync(TMP_HOME, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(TMP_HOME);
    // Explicitly remove hub config so loadHubConfig() returns null.
    delete process.env.AGENFK_HUB_URL;
    delete process.env.AGENFK_HUB_TOKEN;
    delete process.env.AGENFK_HUB_ORG;
    process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS = '3600000';
    process.env.AGENFK_DB_PATH = TEST_DB;
    stubBenignFetch(); // stub before import so any startup fetch is intercepted
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

        /*
     * The server is created right after the dynamic import, in the same hook
     * (BUG 9de0c99c). This file cannot use a module-level `beforeAll` for it,
     * because `app` does not exist until that import runs — but the reason for
     * having ONE server is the same: `agent()` starts and tears down an
     * ephemeral one per call, and that churn produced `Error: Parse Error:
     * Expected HTTP/`, a transport failure that surfaces as a confident wrong
     * assertion in whichever test was running.
     */
    ({ app, initStorage } = await import('../server'));
    __server = app.listen(0);
    await initStorage();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.mocked(os.homedir).mockRestore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    stubBenignFetch(); // re-stub below clears the previous impl (no implicit reset)
  });

  it('GET /flows/org-available reports hub disabled', async () => {
    const r = await agent().get('/flows/org-available');
    expect(r.status).toBe(200);
    expect(r.body.hubEnabled).toBe(false);
    expect(r.body.flows).toEqual([]);
  });

  it('select-org without a hub configured → 400', async () => {
    const project = (await agent().post('/projects').send({ name: 'p' })).body;
    const r = await agent()
      .post(`/projects/${project.id}/flow/select-org`)
      .send({ flowId: 'x' });
    expect(r.status).toBe(400);
  });
});