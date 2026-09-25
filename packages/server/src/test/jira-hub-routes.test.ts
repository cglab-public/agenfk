/**
 * The local server's JIRA routes on an installation JOINED to a hub
 * (CGLAB-412).
 *
 * Joined means the hub is the only JIRA source: status, project/issue
 * listing, import and `--jira-item` validation all go through the hub's relay,
 * with the installation's hub key. A local `agenfk jira setup` config or token
 * left on the machine is ignored - it is planted in the sandbox home here
 * precisely so a regression that reads it shows up. The hub admin configures
 * the org's Atlassian app; each user connects their OWN JIRA from the board,
 * and the local OAuth routes drive that through the hub: authorize asks the
 * hub to start a flow returning to this server's loopback callback, and the
 * callback redeems the hub's one-time completion code with this
 * installation's key.
 *
 * Hub config is forced via env BEFORE importing the server module (hubClient
 * captures config at import) and global fetch is stubbed, so no network is hit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: vi.fn(() => actual.homedir()) }, homedir: vi.fn(() => actual.homedir()) };
});

// Local JIRA must never be called from a joined installation: fail loudly if it is.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const guard = vi.fn((cfg: any) => {
    const url = String(cfg?.url ?? '');
    if (url.includes('atlassian')) throw new Error(`joined installation called Atlassian directly: ${url}`);
    return actual.default(cfg);
  });
  Object.assign(guard, actual.default);
  (guard as any).post = vi.fn(async (url: string, ...rest: any[]) => {
    if (String(url).includes('atlassian')) throw new Error(`joined installation called Atlassian directly: ${url}`);
    return actual.default.post(url, ...rest);
  });
  (guard as any).get = vi.fn(async (url: string, ...rest: any[]) => {
    if (String(url).includes('atlassian')) throw new Error(`joined installation called Atlassian directly: ${url}`);
    return actual.default.get(url, ...rest);
  });
  return { ...actual, default: guard };
});

const TEST_DB = path.resolve('./jira-hub-routes-test-db.sqlite');
const HUB_URL = 'http://hub.example.test';
const HUB_CLOUD_URL = 'https://acme.atlassian.net';
const LOCAL_CLOUD_URL = 'https://local-leftover.atlassian.net';
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
  'JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET',
];
const savedEnv: Record<string, string | undefined> = {};
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-jira-hub-routes-'));

let app: any, initStorage: any, clearHubJiraStatusCache: any;
let __server: any;
const agent = () => request(__server);

/** Mutable hub fake state, reset per test. */
let hubConnected = true;
let hubConfigured = true;
let hubLastError: string | null = null;
let completeStatus = 200;
let hubPosts: Array<{ url: string; body: any }> = [];
let hubDown = false;
let hubKeyRejected = false;
let issueStatus: Record<string, number> = {};
let hubCalls: string[] = [];

function stubHub() {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body }) as any;
    if (url.includes('atlassian')) throw new Error(`joined installation called Atlassian directly: ${url}`);
    if (!url.startsWith(`${HUB_URL}/v1/jira/`)) return reply(204, {});
    hubCalls.push(url);
    if (hubDown) throw new Error('ECONNREFUSED');
    if (hubKeyRejected || auth !== 'Bearer agk_test') return reply(401, { error: 'Invalid or revoked token' });

    const rest = url.slice(`${HUB_URL}/v1/jira/`.length);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      hubPosts.push({ url, body });
      if (rest === 'oauth/start') {
        if (!hubConfigured) return reply(409, { code: 'jira_not_configured', error: 'not configured' });
        return reply(200, { authorizeUrl: `https://auth.atlassian.com/authorize?state=st&return=${encodeURIComponent(body.returnTo)}` });
      }
      if (rest === 'oauth/complete') {
        if (completeStatus !== 200) return reply(completeStatus, { code: 'completion_key_mismatch', error: 'x' });
        hubConnected = true;
        return reply(200, { configured: true, connected: true });
      }
      if (rest === 'disconnect') { hubConnected = false; return reply(200, { configured: true, connected: false }); }
      return reply(404, { code: 'not_relayed' });
    }
    if (rest === 'status') {
      return reply(200, hubConnected && hubConfigured
        ? { configured: true, connected: true, cloudId: 'hub-cloud', cloudUrl: HUB_CLOUD_URL, email: 'bot@acme.test' }
        : { configured: hubConfigured, connected: false, cloudId: null, cloudUrl: null, email: null, lastError: hubLastError });
    }
    if (!hubConnected) return reply(409, { code: 'jira_not_connected', error: 'JIRA is not connected for this organisation.' });
    if (rest.startsWith('rest/api/3/project/search')) {
      return reply(200, { values: [{ id: '10', key: 'ACME', name: 'Acme', projectTypeKey: 'software' }] });
    }
    if (rest.startsWith('rest/api/3/search/jql')) {
      return reply(200, { issues: [{ id: '1', key: 'ACME-1', fields: { summary: 'First', issuetype: { name: 'Story' }, status: { name: 'To Do', statusCategory: { name: 'To Do' } } } }] });
    }
    const m = /^rest\/api\/3\/issue\/([^?]+)/.exec(rest);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const status = issueStatus[key] ?? 200;
      if (status !== 200) return reply(status, { errorMessages: ['Issue does not exist'] });
      return reply(200, { key, fields: { summary: `Summary of ${key}`, description: null, issuetype: { name: 'Story' } } });
    }
    return reply(404, { error: 'Not a relayed JIRA endpoint' });
  }));
}

describe('JIRA routes on a hub-joined installation', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = HUB_URL;
    process.env.AGENFK_HUB_TOKEN = 'agk_test';
    process.env.AGENFK_HUB_ORG = 'org-test';
    process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS = '3600000';
    process.env.AGENFK_DB_PATH = TEST_DB;
    // A fully configured LOCAL JIRA too - which a joined installation must ignore.
    process.env.JIRA_CLIENT_ID = 'local-cid';
    process.env.JIRA_CLIENT_SECRET = 'local-secret';
    stubHub();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    ({ app, initStorage } = await import('../server'));
    ({ clearHubJiraStatusCache } = await import('../jira/hubJira'));
    __server = app.listen(0);
    await initStorage();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hubConnected = true;
    hubConfigured = true;
    hubLastError = null;
    completeStatus = 200;
    hubPosts = [];
    hubDown = false;
    hubKeyRejected = false;
    issueStatus = {};
    hubCalls = [];
    clearHubJiraStatusCache();
    vi.mocked(os.homedir).mockReturnValue(sandboxHome);
    fs.mkdirSync(path.join(sandboxHome, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(sandboxHome, '.agenfk', 'jira-token.json'), JSON.stringify({
      access_token: 'local-at', refresh_token: 'local-rt', cloudId: 'local-cloud', cloudUrl: LOCAL_CLOUD_URL, email: 'me@local.test',
    }));
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    stubHub();
  });

  const newProject = async () => (await agent().post('/projects').send({ name: 'p' })).body;

  describe('GET /jira/status', () => {
    it('reports this user\'s hub connection, not the local token', async () => {
      const r = await agent().get('/jira/status');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ source: 'hub', configured: true, connected: true, cloudUrl: HUB_CLOUD_URL, email: 'bot@acme.test' });
      expect(JSON.stringify(r.body)).not.toContain('me@local.test');
    });

    it('tells the user to connect from the board when the hub app is there but they are not connected', async () => {
      hubConnected = false;
      const r = await agent().get('/jira/status');
      expect(r.body).toMatchObject({ source: 'hub', configured: true, connected: false });
      expect(r.body.message).toMatch(/connect jira/i);
      expect(r.body.message).not.toMatch(/hub admin/i);
    });

    it('says the connection expired when the hub dropped a dead grant', async () => {
      hubConnected = false;
      hubLastError = 'refresh_rejected';
      const r = await agent().get('/jira/status');
      expect(r.body.message).toMatch(/expired/i);
      expect(r.body.message).toMatch(/connect jira/i);
    });

    it('tells the user to ask a hub admin when the hub has no JIRA app', async () => {
      hubConfigured = false;
      const r = await agent().get('/jira/status');
      expect(r.body).toMatchObject({ source: 'hub', configured: false, connected: false });
      expect(r.body.message).toMatch(/hub admin/i);
    });

    it('an unreachable hub is reported, not a crash and not the local token', async () => {
      hubDown = true;
      const r = await agent().get('/jira/status');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ source: 'hub', connected: false, reason: 'hub_unreachable' });
    });
  });

  it('GET /jira/status with a rejected hub key says so, instead of blaming the JIRA connection', async () => {
    hubKeyRejected = true;
    const r = await agent().get('/jira/status');
    expect(r.body).toMatchObject({ source: 'hub', connected: false, reason: 'hub_auth_failed' });
    expect(r.body.message).toMatch(/hub login/);
  });

  describe('connecting and disconnecting go through the hub', () => {
    it('authorize asks the hub to start a flow for this key, returning to our loopback callback, and sends the browser on', async () => {
      const r = await agent().get('/jira/oauth/authorize');
      expect(r.status).toBe(302);
      expect(r.headers.location).toMatch(/^https:\/\/auth\.atlassian\.com\/authorize\?state=st/);
      const start = hubPosts.find(p => p.url === `${HUB_URL}/v1/jira/oauth/start`)!;
      expect(start).toBeTruthy();
      const returnTo = new URL(start.body.returnTo);
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(returnTo.hostname);
      expect(returnTo.pathname).toBe('/jira/oauth/callback');
    });

    it('authorize reached under a non-loopback Host never asks the hub (the code must come back to THIS machine)', async () => {
      const r = await agent().get('/jira/oauth/authorize').set('Host', 'evil.test');
      expect(r.status).toBe(302);
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=not_loopback/);
      expect(hubPosts).toHaveLength(0);
    });

    it('authorize with no JIRA app on the hub returns to the board with a reason', async () => {
      hubConfigured = false;
      const r = await agent().get('/jira/oauth/authorize');
      expect(r.status).toBe(302);
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=jira_not_configured/);
    });

    /** Start a connect the way the board does, so a completion is expected. */
    const beginConnect = async () => {
      expect((await agent().get('/jira/oauth/authorize')).status).toBe(302);
      hubPosts = [];
    };

    it('a completion arriving with no connect started here is refused, and never reaches the hub', async () => {
      await agent().get('/jira/oauth/callback?error=reset'); // consume anything a previous test left pending
      hubPosts = [];
      const r = await agent().get(`/jira/oauth/callback?completion=${'c'.repeat(64)}`);
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=no_pending_connect/);
      expect(hubPosts).toHaveLength(0);
    });

    it('a pending connect is single-use: a second completion after it is refused', async () => {
      await beginConnect();
      expect((await agent().get(`/jira/oauth/callback?completion=${'c'.repeat(64)}`)).headers.location).toMatch(/jira=connected/);
      const again = await agent().get(`/jira/oauth/callback?completion=${'d'.repeat(64)}`);
      expect(again.headers.location).toMatch(/reason=no_pending_connect/);
    });

    it('the callback redeems the completion code with this key, then lands on the board connected', async () => {
      hubConnected = false;
      await beginConnect();
      const code = 'c'.repeat(64);
      const r = await agent().get(`/jira/oauth/callback?completion=${code}`);
      expect(r.status).toBe(302);
      expect(r.headers.location).toMatch(/[?&]jira=connected/);
      expect(hubPosts).toContainEqual({ url: `${HUB_URL}/v1/jira/oauth/complete`, body: { completion: code } });
      expect((await agent().get('/jira/status')).body.connected).toBe(true);
    });

    it('a completion the hub refuses lands on the board with its reason', async () => {
      completeStatus = 403;
      await beginConnect();
      const r = await agent().get(`/jira/oauth/callback?completion=${'c'.repeat(64)}`);
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=completion_key_mismatch/);
    });

    it('a denied consent lands on the board with its reason and redeems nothing', async () => {
      const r = await agent().get('/jira/oauth/callback?error=access_denied');
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=access_denied/);
      expect(hubPosts).toHaveLength(0);
    });

    it('a callback carrying a local-OAuth code (not a hub completion) is refused', async () => {
      const r = await agent().get('/jira/oauth/callback?code=c&state=s');
      expect(r.headers.location).toMatch(/[?&]jira=error&reason=missing_params/);
      expect(hubPosts).toHaveLength(0);
    });

    it('disconnect drops this user\'s hub connection and leaves the (ignored) local file alone', async () => {
      const r = await agent().post('/jira/disconnect');
      expect(r.status).toBe(200);
      expect(hubPosts).toContainEqual({ url: `${HUB_URL}/v1/jira/disconnect`, body: undefined });
      expect((await agent().get('/jira/status')).body.connected).toBe(false);
      expect(fs.existsSync(path.join(sandboxHome, '.agenfk', 'jira-token.json'))).toBe(true);
    });
  });

  describe('listing and import go through the hub', () => {
    it('GET /jira/projects relays project/search via the hub', async () => {
      const r = await agent().get('/jira/projects');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{ id: '10', key: 'ACME', name: 'Acme', type: 'software' }]);
      expect(hubCalls).toContain(`${HUB_URL}/v1/jira/rest/api/3/project/search?maxResults=50`);
    });

    it('GET /jira/projects when this user is not connected is a 409 saying to connect', async () => {
      hubConnected = false;
      const r = await agent().get('/jira/projects');
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/connect jira/i);
      expect(r.body.error).not.toMatch(/hub admin/i);
    });

    it('GET /jira/projects/:key/issues relays the (escaped) JQL search via the hub', async () => {
      const r = await agent().get('/jira/projects/ACME/issues');
      expect(r.status).toBe(200);
      expect(r.body[0]).toMatchObject({ key: 'ACME-1', summary: 'First', mappedType: 'STORY' });
      const search = hubCalls.find(u => u.includes('/rest/api/3/search/jql'))!;
      expect(search).toContain(encodeURIComponent('project = "ACME"'));
    });

    it('POST /jira/import creates the card with a browse URL on the ORG\'s site', async () => {
      const project = await newProject();
      const r = await agent().post('/jira/import').send({ projectId: project.id, items: [{ issueKey: 'ACME-7', type: 'STORY' }] });
      expect(r.status).toBe(200);
      const items = (await agent().get(`/items?projectId=${project.id}`)).body;
      const card = items.find((i: any) => i.externalId === 'ACME-7');
      expect(card).toBeTruthy();
      expect(card.title).toContain('Summary of ACME-7');
      expect(card.externalUrl).toBe(`${HUB_CLOUD_URL}/browse/ACME-7`);
    });

    it('POST /jira/import accepts a lower-case key, as an unjoined import does', async () => {
      const project = await newProject();
      const r = await agent().post('/jira/import').send({ projectId: project.id, items: [{ issueKey: 'acme-8', type: 'STORY' }] });
      expect(r.status).toBe(200);
      expect(r.body.errors).toEqual([]);
      expect(hubCalls.some(u => u.startsWith(`${HUB_URL}/v1/jira/rest/api/3/issue/ACME-8`))).toBe(true);
    });

    it('POST /jira/import when the org has no connection is a 409 and creates nothing', async () => {
      hubConnected = false;
      const project = await newProject();
      const r = await agent().post('/jira/import').send({ projectId: project.id, items: [{ issueKey: 'ACME-7', type: 'STORY' }] });
      expect(r.status).toBe(409);
      const items = (await agent().get(`/items?projectId=${project.id}`)).body;
      expect(items).toHaveLength(0);
    });
  });

  describe('--jira-item validation goes through the hub', () => {
    it('a real key links with the org site\'s browse URL', async () => {
      const project = await newProject();
      const r = await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 't', jiraItem: 'ACME-12' });
      expect(r.status).toBe(201);
      expect(r.body.externalId).toBe('ACME-12');
      expect(r.body.externalUrl).toBe(`${HUB_CLOUD_URL}/browse/ACME-12`);
      expect(hubCalls.some(u => u.startsWith(`${HUB_URL}/v1/jira/rest/api/3/issue/ACME-12`))).toBe(true);
    });

    it('a key JIRA does not know is refused, as with a local connection', async () => {
      issueStatus = { 'ACME-404': 404 };
      const project = await newProject();
      const r = await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 't', jiraItem: 'ACME-404' });
      expect(r.status).toBe(400);
    });

    it('with no org connection the key is stored bare and flagged unverified', async () => {
      hubConnected = false;
      const project = await newProject();
      const r = await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 't', jiraItem: 'ACME-12' });
      expect(r.status).toBe(201);
      expect(r.body.externalId).toBe('ACME-12');
      expect(r.body.externalUrl ?? null).toBeNull();
      expect(String(r.body.jiraWarning ?? '')).toMatch(/connect jira/i);
      expect(String(r.body.jiraWarning ?? '')).not.toMatch(/hub admin/i);
    });

    it('an unreachable hub links the key with a warning, like an unreachable JIRA', async () => {
      hubDown = true;
      const project = await newProject();
      const r = await agent().post('/items').send({ projectId: project.id, type: 'TASK', title: 't', jiraItem: 'ACME-12' });
      expect(r.status).toBe(201);
      expect(r.body.externalId).toBe('ACME-12');
      expect(String(r.body.jiraWarning ?? '')).toMatch(/verif/i);
    });
  });
});
