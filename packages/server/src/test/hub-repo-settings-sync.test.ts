/**
 * Unit tests for the client side of hub repository settings (RFC-002).
 *
 * `syncRepoSettings` pulls the hub's authoritative settings for one project's
 * git remote from `GET /v1/repo-settings?repo=`, claims the repository's own
 * command on first contact with `POST /v1/repo-settings/init`, and stores the
 * result on the project as `hubRepoSettings`. `runFlowSyncTick` drives it for
 * every project that has a remote, after the flow reconcile, with its own ETag
 * cache key `repo:<projectId>`.
 *
 * A fake fetch routes by URL and method and records every call, so a spec can
 * say what the hub answered without saying who asked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { runFlowSyncTick } from '../hub/flowSync';
import { syncRepoSettings } from '../hub/repoSettingsSync';

const HUB_URL = 'http://hub.example.test';
const HUB_TOKEN = 'agk_test';
const HUB_ORG = 'org-a';
const REMOTE = 'git@github.com:acme/widget.git';

const SETTINGS = {
  remoteUrl: REMOTE,
  verifyCommand: 'npm run verify:ci',
  revision: 7,
  receiptsMode: 'shadow',
  shadowThreshold: 12,
  producers: ['github-app'],
  syncedAt: '2025-01-01T00:00:00.000Z',
};

/** One GET's worth of answers, plus what the hub hands back for an init. */
interface Routes {
  get?: { status: number; body?: any; etag?: string };
  init?: { status: number; body?: any };
  /** Throw instead of answering (network failure). */
  throwOn?: 'get' | 'init';
}

interface Call { url: string; method: string; headers: any; body: any }

/**
 * A fetch that routes by URL and method and records every call, in order, so a
 * spec can assert both what was sent and what was never sent.
 */
function makeHubFetch(routes: Routes) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, opts: any) => {
    const method: string = opts?.method ?? 'GET';
    const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : undefined;
    const isInit = /\/v1\/repo-settings\/init/.test(url) && method === 'POST';
    const isGet = /\/v1\/repo-settings\?/.test(url) && (method === 'GET' || method === undefined);
    const isFlow = /\/v1\/flows\/active/.test(url);
    calls.push({ url, method, headers: opts?.headers ?? {}, body });
    if (isFlow) return answer({ status: 200, body: { flow: null }, etag: 'W/"flow-1"' });
    if (isInit) {
      if (routes.throwOn === 'init') throw new Error('ECONNREFUSED init');
      return answer(routes.init ?? { status: 204, body: null });
    }
    if (isGet) {
      if (routes.throwOn === 'get') throw new Error('ECONNREFUSED');
      return answer(routes.get ?? { status: 200, body: { settings: null } });
    }
    return answer({ status: 404, body: { error: 'no route' } });
  });
  return { fetchImpl: fetchImpl as any, calls };
}

function answer(r: { status: number; body?: any; etag?: string }) {
  const headers: Record<string, string> = {};
  if (r.etag) headers['etag'] = r.etag;
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => r.body ?? {},
  } as any;
}

const settingsPath = (n: number) => ({
  remoteUrl: REMOTE,
  verifyCommand: `hub-verify-${n}`,
  revision: n,
  receiptsMode: 'off',
  shadowThreshold: null,
  producers: [],
  syncedAt: '2025-01-01T00:00:00.000Z',
});

async function mkProject(storage: SQLiteStorageProvider, id: string, extra: Record<string, any> = {}) {
  await storage.createProject({ id, name: id, description: '', createdAt: new Date(), updatedAt: new Date(), ...extra } as any);
  return id;
}

describe('hub repoSettingsSync.syncRepoSettings', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `hub-repo-settings-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
  });

  const args = (over: Partial<Parameters<typeof syncRepoSettings>[0]> = {}) => ({
    storage,
    hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
    projectId: 'p1',
    remoteUrl: REMOTE,
    localCommand: null,
    lastEtag: null,
    fetchImpl: makeHubFetch({}).fetchImpl,
    ...over,
  } as any);

  it('the hub has settings → adopts them onto the project, with the token and the repo query', async () => {
    await mkProject(storage, 'p1');
    const { fetchImpl, calls } = makeHubFetch({ get: { status: 200, etag: 'W/"r7"', body: { settings: SETTINGS } } });

    const result = await syncRepoSettings(args({ fetchImpl }));

    expect(result.outcome).toBe('adopted');
    expect(result.etag).toBe('W/"r7"');
    const stored: any = (await storage.getProject('p1'))?.hubRepoSettings;
    expect(stored).toBeTruthy();
    expect(stored.verifyCommand).toBe('npm run verify:ci');
    expect(stored.revision).toBe(7);
    expect(stored.receiptsMode).toBe('shadow');
    expect(stored.shadowThreshold).toBe(12);
    expect(stored.producers).toEqual(['github-app']);
    expect(stored.syncedAt).toBeTruthy();

    const get = calls.find((c) => c.method === 'GET')!;
    expect(get.url).toContain(`${HUB_URL}/v1/repo-settings?repo=`);
    expect(decodeURIComponent(get.url)).toContain(REMOTE);
    expect(get.headers['Authorization']).toBe(`Bearer ${HUB_TOKEN}`);
  });

  // RFC-002 Amendment 1 (GH #289): the producer mode rides along beside the
  // explicit list, which keeps its meaning and its shape.
  it('stores the producer mode the hub sends, with the explicit list unchanged beside it', async () => {
    await mkProject(storage, 'p1');
    const { fetchImpl } = makeHubFetch({ get: { status: 200, body: { settings: { ...SETTINGS, producerMode: 'all' } } } });
    expect((await syncRepoSettings(args({ fetchImpl }))).outcome).toBe('adopted');
    const stored: any = (await storage.getProject('p1'))?.hubRepoSettings;
    expect(stored.producerMode).toBe('all');
    expect(stored.producers).toEqual(['github-app']);
  });

  it('reads an older hub that sends no producer mode, or one it does not know, as "only these installations"', async () => {
    for (const [i, producerMode] of [undefined, 'everyone', 7].entries()) {
      const id = `p-old-${i}`;
      await mkProject(storage, id);
      const { fetchImpl } = makeHubFetch({ get: { status: 200, body: { settings: { ...SETTINGS, producerMode } } } });
      expect((await syncRepoSettings(args({ fetchImpl, projectId: id }))).outcome).toBe('adopted');
      const stored: any = (await storage.getProject(id))?.hubRepoSettings;
      expect(stored.producerMode, String(producerMode)).toBe('listed');
    }
  });

  it('sends If-None-Match from lastEtag, and a 304 writes nothing', async () => {
    await mkProject(storage, 'p1');
    const before = await storage.getProject('p1');
    const { fetchImpl, calls } = makeHubFetch({ get: { status: 304 } });

    const result = await syncRepoSettings(args({ fetchImpl, lastEtag: 'W/"r7"' }));

    expect(result).toEqual({ outcome: 'not-modified', etag: 'W/"r7"' });
    const get = calls.find((c) => c.method === 'GET')!;
    expect(get.headers['If-None-Match']).toBe('W/"r7"');
    expect((await storage.getProject('p1'))?.hubRepoSettings).toEqual(before?.hubRepoSettings);
  });

  it('the hub has none and we have a local command → claims it, and stores the WINNER the hub returned', async () => {
    await mkProject(storage, 'p1', { verifyCommand: 'make check' });
    // The hub already holds another producer's claim: what it returns is what we store.
    const winner = { ...settingsPath(3), verifyCommand: 'pnpm run verify' };
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null }, etag: 'W/"r1"' },
      init: { status: 201, body: { settings: winner } },
    });

    const result = await syncRepoSettings(args({ fetchImpl, localCommand: 'make check' }));

    expect(result.outcome).toBe('initialized');
    const init = calls.find((c) => c.method === 'POST')!;
    expect(init.url).toBe(`${HUB_URL}/v1/repo-settings/init`);
    expect(init.body).toEqual({ repo: REMOTE, verifyCommand: 'make check' });
    expect(init.headers['Authorization']).toBe(`Bearer ${HUB_TOKEN}`);

    const stored: any = (await storage.getProject('p1'))?.hubRepoSettings;
    expect(stored.verifyCommand).toBe('pnpm run verify');
    expect(stored.revision).toBe(3);
  });

  it('claims the repository with a path inside the checkout rewritten to repo-relative', async () => {
    // The hub hands the command to every clone and runs it from the repository
    // root, so an absolute path into THIS checkout must go over as a relative
    // one: `/work/app/scripts/verify.js` is Ana's checkout, `./scripts/verify.js`
    // is everybody's.
    await mkProject(storage, 'p1');
    const winner = settingsPath(1);
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: winner } },
    });

    const result = await syncRepoSettings(args({ fetchImpl, localCommand: 'node /work/app/scripts/verify.js', projectRoot: '/work/app' }));

    expect(result.outcome, JSON.stringify(result)).toBe('initialized');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ repo: REMOTE, verifyCommand: 'node ./scripts/verify.js' });
  });

  it('a command naming a path outside the checkout is never POSTed: error, and the reason names the path', async () => {
    await mkProject(storage, 'p1');
    const before = await storage.getProject('p1');
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    const result = await syncRepoSettings(args({ fetchImpl, localCommand: 'bash /opt/tools/check.sh', projectRoot: '/work/app' }));

    expect(result.outcome, JSON.stringify(result)).toBe('error');
    expect((result as any).error).toContain('/opt/tools/check.sh');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await storage.getProject('p1'))?.hubRepoSettings).toEqual(before?.hubRepoSettings);
  });

  it('a local command with no path at all is claimed as written, with or without a project root', async () => {
    await mkProject(storage, 'p1');
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    expect((await syncRepoSettings(args({ fetchImpl, localCommand: 'make check' }))).outcome).toBe('initialized');
    expect((await syncRepoSettings(args({ fetchImpl, localCommand: 'pnpm verify', projectRoot: '/work/app' }))).outcome).toBe('initialized');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body.verifyCommand)).toEqual(['make check', 'pnpm verify']);
  });

  it('the hub has none and we have no local command → none, no POST, nothing written', async () => {
    await mkProject(storage, 'p1');
    const { fetchImpl, calls } = makeHubFetch({ get: { status: 200, body: { settings: null } } });

    const result = await syncRepoSettings(args({ fetchImpl }));

    expect(result).toEqual({ outcome: 'none', etag: null });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await storage.getProject('p1'))?.hubRepoSettings).toBeFalsy();
  });

  it('a GET answering 500 → error, no init POST, and stored settings untouched', async () => {
    await mkProject(storage, 'p1');
    await storage.updateProject('p1', { hubRepoSettings: settingsPath(9) } as any);
    const { fetchImpl, calls } = makeHubFetch({ get: { status: 500, body: { error: 'boom' } } });

    const result = await syncRepoSettings(args({ fetchImpl, localCommand: 'make check' }));

    expect(result.outcome).toBe('error');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await storage.getProject('p1'))?.hubRepoSettings).toEqual(settingsPath(9));
  });

  it('the fetch throwing → error, no init POST, stored settings untouched', async () => {
    await mkProject(storage, 'p1');
    await storage.updateProject('p1', { hubRepoSettings: settingsPath(9) } as any);
    const { fetchImpl, calls } = makeHubFetch({ throwOn: 'get' });

    const result = await syncRepoSettings(args({ fetchImpl, localCommand: 'make check' }));

    expect(result.outcome).toBe('error');
    expect((result as any).error).toMatch(/ECONNREFUSED/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await storage.getProject('p1'))?.hubRepoSettings).toEqual(settingsPath(9));
  });
});

describe('runFlowSyncTick also pulls repo settings', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `hub-repo-tick-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
  });

  const settingsUrl = (url: string) => /\/v1\/repo-settings\?/.test(url);
  const projectOf = (url: string) => decodeURIComponent(url).match(/repo=([^&]+)/)?.[1];

  it('asks for the settings of a project with a remote and caches the etag under repo:<projectId>', async () => {
    await mkProject(storage, 'pa');
    const { fetchImpl, calls } = makeHubFetch({ get: { status: 200, etag: 'W/"rs-4"', body: { settings: SETTINGS } } });
    const etagCache = new Map<string, string>();

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache,
      resolveRepo: async (projectId) => (projectId === 'pa' ? REMOTE : null),
    } as any);

    const asked = calls.filter((c) => settingsUrl(c.url));
    expect(asked.map((c) => projectOf(c.url))).toEqual([REMOTE]);
    expect((await storage.getProject('pa'))?.hubRepoSettings).toBeTruthy();
    expect(etagCache.get('repo:pa')).toBe('W/"rs-4"');
  });

  it('does not ask for a project with no remote', async () => {
    await mkProject(storage, 'pb');
    const { fetchImpl, calls } = makeHubFetch({});

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async () => null,
    } as any);

    expect(calls.filter((c) => settingsUrl(c.url))).toHaveLength(0);
    expect((await storage.getProject('pb'))?.hubRepoSettings).toBeFalsy();
  });

  it('a settings failure on one project does not stop the next project', async () => {
    await mkProject(storage, 'pa');
    await mkProject(storage, 'pb');
    const second = settingsPath(2);
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, opts: any) => {
      const method: string = opts?.method ?? 'GET';
      calls.push({ url, method, headers: opts?.headers ?? {}, body: undefined });
      if (/\/v1\/flows\/active/.test(url)) return answer({ status: 200, body: { flow: null } });
      if (settingsUrl(url)) {
        // The first remote is a hub that answers nothing; the second is fine.
        if (projectOf(url) === 'https://a.test/x.git') throw new Error('ECONNREFUSED');
        return answer({ status: 200, etag: 'W/"rs-2"', body: { settings: second } });
      }
      return answer({ status: 404, body: {} });
    }) as any;

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async (projectId) => (projectId === 'pa' ? 'https://a.test/x.git' : 'https://b.test/y.git'),
    } as any);

    expect((await storage.getProject('pa'))?.hubRepoSettings).toBeFalsy();
    expect((await storage.getProject('pb'))?.hubRepoSettings).toBeTruthy();
  });

  it("claims the repository with the project's stored command when the hub has none", async () => {
    await mkProject(storage, 'pa', { verifyCommand: 'make check' });
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async (projectId) => (projectId === 'pa' ? REMOTE : null),
    } as any);

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ repo: REMOTE, verifyCommand: 'make check' });
  });

  it("rewrites a path inside the project root before claiming it — the root is the project's", async () => {
    // The claim is written with the project's own checkout as the root, not with
    // whatever directory the server happens to run in. The repository declares
    // its command with a path that points back into its own checkout — what a
    // machine-local editor writes into `.agenfk/project.json`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-root-'));
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: `node ${path.join(dir, 'scripts', 'verify.js')}` }));
    await mkProject(storage, 'pa', { projectRoot: dir });
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async (projectId) => (projectId === 'pa' ? REMOTE : null),
    } as any);

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.verifyCommand.replace(/\\/g, '/')).toBe('node ./scripts/verify.js');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a project whose command names a path outside its checkout never claims the repository: the POST is withheld', async () => {
    // The whole point of refusing on the client: a command that would only run on
    // this machine must not become the record every other clone is handed. The
    // sync's own error is swallowed per project by the tick (a hub outage on one
    // project must not stop the next), so what the tick has to prove is that no
    // POST left and nothing was stored.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-outside-'));
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'bash /opt/tools/check.sh' }));
    await mkProject(storage, 'pa', { projectRoot: dir });
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async (projectId) => (projectId === 'pa' ? REMOTE : null),
    } as any);

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await storage.getProject('pa'))?.hubRepoSettings).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the repository-declared command over the stored one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-'));
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand: 'npm run declared' }));
    await mkProject(storage, 'pa', { verifyCommand: 'make check', projectRoot: dir });
    const { fetchImpl, calls } = makeHubFetch({
      get: { status: 200, body: { settings: null } },
      init: { status: 201, body: { settings: settingsPath(1) } },
    });

    await runFlowSyncTick({
      storage,
      hubConfig: { url: HUB_URL, token: HUB_TOKEN, orgId: HUB_ORG },
      fetchImpl,
      emit: vi.fn(),
      etagCache: new Map<string, string>(),
      resolveRepo: async (projectId) => (projectId === 'pa' ? REMOTE : null),
    } as any);

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.verifyCommand).toBe('npm run declared');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
