/**
 * CGLAB-138 — a hub-connected installation resolves its flow registry through
 * the hub instead of the baked-in public repo.
 *
 * Why this matters even though the hub has its own registry surface: the
 * FlowEditorModal inside a *client* talks to the local server's
 * /registry/flows. If that stayed pinned to cglab-public, an org that moved to
 * a private registry would still see the community catalogue in the client
 * while the hub showed something else — two sources of truth, and the client
 * one would offer flows the org deliberately sealed away.
 *
 * The local server must NOT hold the org's GitHub token (it belongs to the
 * hub), so it asks the hub to proxy. When the hub is unreachable the honest
 * answer is an error, not a silent fall-back to the public repo — falling back
 * would show a sealed org exactly the flows it moved away from.
 *
 * Hub config is forced via env BEFORE the dynamic server import (hubClient
 * captures config at import time) and env is restored afterwards, following
 * the convention in flow-org-available-hub-on.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';

const TEST_DB = path.resolve('./server-flow-registry-hub-test-db.sqlite');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any;

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const axiosGet = vi.fn();
vi.mock('axios', () => {
  const m = vi.fn() as any;
  m.get = axiosGet;
  m.post = vi.fn();
  m.create = vi.fn(() => m);
  return { default: m };
});

type HubReply = { ok: boolean; status: number; body?: any } | { error: string };
let hubReply: HubReply = { ok: true, status: 200, body: [] };
const hubCalls: Array<{ url: string; auth?: string }> = [];

function stubHubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    hubCalls.push({ url: String(url), auth: init?.headers?.Authorization });
    const r = hubReply;
    if ('error' in r) throw new Error(r.error);
    return {
      status: r.status, ok: r.ok,
      headers: { get: () => null },
      json: async () => r.body,
    } as any;
  }));
}

describe('GET /registry/flows with a hub connection (CGLAB-138)', () => {
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
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  beforeEach(() => {
    hubCalls.length = 0;
    axiosGet.mockReset();
    axiosGet.mockResolvedValue({ data: [] });
    hubReply = { ok: true, status: 200, body: [] };
    stubHubFetch();
  });

  it('asks the hub rather than GitHub when hub mode is on', async () => {
    hubReply = {
      ok: true, status: 200,
      body: { repo: 'acme-corp/agenfk-flows', flows: [{ filename: 'x.json', name: 'X', stepCount: 2 }] },
    };
    const res = await request(app).get('/registry/flows');
    expect(res.status).toBe(200);
    // The hub is the source of truth: its payload is passed through.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('X');
    expect(hubCalls.some((c) => c.url.includes('/v1/registry/flows'))).toBe(true);
  });

  it('authenticates to the hub with the installation token, and never to GitHub directly', async () => {
    hubReply = { ok: true, status: 200, body: { repo: 'acme-corp/agenfk-flows', flows: [] } };
    await request(app).get('/registry/flows');
    const call = hubCalls.find((c) => c.url.includes('/v1/registry/flows'));
    expect(call).toBeTruthy();
    expect(call!.auth).toBe('Bearer agk_test');
    // The org's GitHub token must never reach this machine, and this machine
    // must not go straight to GitHub for an org-managed registry.
    expect(JSON.stringify(hubCalls)).not.toMatch(/api\.github\.com/);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('reports an error when the hub is unreachable instead of silently showing public flows', async () => {
    // 502, not 200-with-public-flows. A sealed org must never be shown the
    // community catalogue because the hub happened to be down.
    hubReply = { error: 'ECONNREFUSED' };
    const res = await request(app).get('/registry/flows');
    expect(res.status).toBe(502);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.hubEnabled).toBe(true);
    // And critically: we did not fall through to the public registry.
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('surfaces a hub 4xx rather than masking it as an empty registry', async () => {
    hubReply = { ok: false, status: 403, body: { error: 'forbidden' } };
    const res = await request(app).get('/registry/flows');
    expect(res.status).toBe(502);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  // ── install follows the same rule ──────────────────────────────────────
  // Browsing from the org repo while INSTALLING from the public one would let
  // an org member pull in a community flow the org sealed away — the browse
  // list is the only thing standing between them and that.
  it('installs through the hub, not GitHub, when hub mode is on', async () => {
    hubReply = {
      ok: true, status: 200,
      body: {
        repo: 'acme-corp/agenfk-flows',
        flow: {
          name: 'Org Flow', description: '',
          steps: [
            { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
            { name: 'BUILD', label: 'Build', order: 1 },
            { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
          ],
        },
      },
    };
    const res = await request(app).post('/registry/flows/install').send({ filename: 'org-flow.json' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Org Flow');
    expect(hubCalls.some((c) => c.url.includes('/v1/registry/flows/install'))).toBe(true);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('refuses to install when the hub is unreachable', async () => {
    hubReply = { error: 'ECONNREFUSED' };
    const res = await request(app).post('/registry/flows/install').send({ filename: 'x.json' });
    expect(res.status).toBe(502);
    expect(axiosGet).not.toHaveBeenCalled();
  });
});
