/**
 * GH-346 review: a repoint moved only the event flusher. The flows, Airlock,
 * receipts and upgrade channels kept the old hub (and presented its token
 * there) until the server restarted, so once the old name was retired the
 * installation stopped taking policy, flows and upgrades while its events kept
 * arriving, and the hub showed it as healthy.
 *
 * After a verified move every channel must talk to the new hub.
 *
 * Both transports are stubbed: a repoint target must be https and must not be
 * a loopback or private address (repointSync's guard), so no local server can
 * stand in for the new hub. The hub is configured through hub.json, as on a
 * real machine: AGENFK_HUB_URL overrides hub.json and blocks a repoint.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const OLD = 'https://hub-a.example.test';
const NEW = 'https://hub-b.example.test';
const ORG = 'org-repoint';

/** Every hub URL either transport asked for, in order. */
const asked: string[] = [];
/** Each event the flusher delivered, with the hub it went to. */
const delivered: Array<{ url: string; type: string }> = [];

vi.mock('axios', async (importOriginal) => {
  const actual: any = await importOriginal();
  const answer = (url: string) => {
    asked.push(url);
    if (url === `${OLD}/v1/repoint-directive`) {
      return { status: 200, data: { campaignId: 'c-1', targetUrl: NEW, allowedHost: 'hub-b.example.test' } };
    }
    if (url === `${NEW}/healthz`) return { status: 200, data: { service: 'agenfk-hub' } };
    if (url === `${NEW}/v1/ping`) return { status: 200, data: { orgId: ORG } };
    return { status: 204, data: '' };
  };
  const get = vi.fn(async (url: string) => answer(url));
  const create = vi.fn((cfg: any) => {
    const at = (p: string) => `${String(cfg?.baseURL ?? '').replace(/\/$/, '')}${p}`;
    return {
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      get: vi.fn(async (p: string) => answer(at(p))),
      post: vi.fn(async (p: string, body: any) => {
        asked.push(at(p));
        const events: any[] = Array.isArray(body?.events) ? body.events : [];
        for (const e of events) delivered.push({ url: at(p), type: e?.type });
        return { status: 200, data: { ingested: events.length, skipped: 0, rejected: [] } };
      }),
    };
  });
  return { ...actual, default: { ...actual.default, get, create } };
});

const TEST_DB = testDbPath('hub-repoint-adopt-server-test-db.sqlite');
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH',
  'AGENFK_TEST_ENABLE_HUB', 'AGENFK_HUB_SYNC_FIRST_DELAY_MS', 'AGENFK_HUB_SYNC_INTERVAL_MS',
];
const savedEnv: Record<string, string | undefined> = {};
const hubJson = path.join(os.homedir(), '.agenfk', 'hub.json');
let savedHubJson: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let closeStorage: any;

describe('a repoint moves every hub channel (GH-346)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.AGENFK_HUB_URL;
    delete process.env.AGENFK_HUB_TOKEN;
    delete process.env.AGENFK_HUB_ORG;
    process.env.AGENFK_DB_PATH = TEST_DB;
    process.env.AGENFK_TEST_ENABLE_HUB = '1';
    process.env.AGENFK_HUB_SYNC_FIRST_DELAY_MS = '0';
    process.env.AGENFK_HUB_SYNC_INTERVAL_MS = '100';
    savedHubJson = fs.existsSync(hubJson) ? fs.readFileSync(hubJson, 'utf8') : null;
    fs.mkdirSync(path.dirname(hubJson), { recursive: true });
    fs.writeFileSync(hubJson, JSON.stringify({ url: OLD, token: 'agk_repoint', orgId: ORG }), { mode: 0o600 });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(String(url));
      return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
    }));

    await removeTestDb(TEST_DB);
    let initStorage: any;
    ({ initStorage, closeStorage } = await import('../server'));
    await initStorage();
    await (await import('../server')).storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() });
  });

  afterAll(async () => {
    await removeTestDb(TEST_DB, closeStorage);
    vi.unstubAllGlobals();
    if (savedHubJson === null) fs.rmSync(hubJson, { force: true });
    else fs.writeFileSync(hubJson, savedHubJson, { mode: 0o600 });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  });

  it('after a verified move, flows, Airlock, upgrade and events all go to the new hub', async () => {
    const seen = (p: string) => asked.some(u => u.startsWith(`${NEW}${p}`));
    for (let i = 0; i < 300 && !(seen('/v1/flows') && seen('/v1/airlock/policy') && seen('/v1/upgrade-directive') && seen('/v1/events')); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(JSON.parse(fs.readFileSync(hubJson, 'utf8')).url).toBe(NEW);
    expect(seen('/v1/events')).toBe(true);
    expect(seen('/v1/flows')).toBe(true);
    expect(seen('/v1/airlock/policy')).toBe(true);
    expect(seen('/v1/upgrade-directive')).toBe(true);
    // The move's own confirmation, acknowledged by the NEW hub: the only evidence it accepts.
    for (let i = 0; i < 300 && !delivered.some(d => d.type === 'hub:repoint:succeeded'); i++) await new Promise(r => setTimeout(r, 10));
    expect(delivered.filter(d => d.type === 'hub:repoint:succeeded').map(d => d.url)).toEqual([`${NEW}/v1/events`]);
  });

  it('once moved, nothing more is asked of the old hub', async () => {
    const cut = asked.length;
    await new Promise(r => setTimeout(r, 400));
    expect(asked.slice(cut).filter(u => u.startsWith(OLD))).toEqual([]);
  });
});
