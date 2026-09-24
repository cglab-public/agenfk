import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage, oauthStateStore, mapJiraTypeToAgEnFK, clearJiraValidationCache, VERIFY_TOKEN } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';
import { Status, ItemType, AgEnFKItem } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 76 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

// Mockable homedir (item 9c297075) — the JIRA block re-points it per test so
// its token/config cycles can never touch the real ~/.agenfk under any runner.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

const TEST_DB = path.resolve('./server-test-db.sqlite');

describe('Server API', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  describe('GET /projects', () => {
    it('should return empty list initially', async () => {
      const res = await agent().get('/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('PUT /projects/:id', () => {
    it('should update a project', async () => {
      const createRes = await agent()
        .post('/projects')
        .send({ name: 'P1' });
      const id = createRes.body.id;

      const res = await agent()
        .put(`/projects/${id}`)
        .send({ name: 'P1 Updated' });
      
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('P1 Updated');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await agent()
        .put('/projects/none')
        .send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /projects/:id', () => {
    it('should delete a project', async () => {
      const createRes = await agent()
        .post('/projects')
        .send({ name: 'To Delete' });
      const id = createRes.body.id;

      const res = await agent().delete(`/projects/${id}`);
      expect(res.status).toBe(204);

      const getRes = await agent().get(`/projects/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe('GET /items', () => {
    it('should return empty items list', async () => {
      const res = await agent().get('/items');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('Items Lifecycle', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await agent().post('/projects').send({ name: 'Item Test' });
      projectId = res.body.id;
      await bindRoleLessDefaultFlow(storage, projectId);
    });

    it('should create an item', async () => {
      const res = await agent()
        .post('/items')
        .send({
          projectId,
          type: ItemType.TASK,
          title: 'T1',
          description: 'D1'
        });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('T1');
    });

    it('should move an item status back, and only let the board move it forward (CGLAB-377)', async () => {
      const createRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'To Update', description: 'D' });
      const id = createRes.body.id;

      const refused = await agent().put(`/items/${id}`).send({ status: Status.IN_PROGRESS });
      expect(refused.status).toBe(409);

      const res = await agent()
        .put(`/items/${id}`)
        .set('x-agenfk-ui', '1')
        .send({ status: Status.IN_PROGRESS });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Status.IN_PROGRESS);

      const back = await agent().put(`/items/${id}`).send({ status: Status.TODO });
      expect(back.status).toBe(200);
      expect(back.body.status).toBe(Status.TODO);
    });

    it('should block direct transition to DONE', async () => {
      const createRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'No Cheat', description: 'D' });
      const id = createRes.body.id;

      const res = await agent()
        .put(`/items/${id}`)
        .send({ status: Status.DONE });
      
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('WORKFLOW VIOLATION');
    });

    it('should refuse DONE even with the internal token (CGLAB-377)', async () => {
      const createRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Verify Me', description: 'D' });
      const id = createRes.body.id;

      const res = await agent()
        .put(`/items/${id}`)
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ status: Status.DONE });

      expect(res.status).toBe(403);
      expect((await agent().get(`/items/${id}`)).body.status).toBe(Status.TODO);
    });

    it('should propagate status to parent', async () => {
      const storyRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent Story', description: 'D' });
      const storyId = storyRes.body.id;

      const taskRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Child Task', description: 'D', parentId: storyId });
      const taskId = taskRes.body.id;

      // Update child to IN_PROGRESS
      await agent().put(`/items/${taskId}`).set('x-agenfk-ui', '1').send({ status: Status.IN_PROGRESS });

      // Check parent
      const parentRes = await agent().get(`/items/${storyId}`);
      expect(parentRes.body.status).toBe(Status.IN_PROGRESS);
    });

    it('should treat parent as DONE when all active children are DONE and one is TRASHED', async () => {
      const storyRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent with Trashed Child' });
      const storyId = storyRes.body.id;

      const task1Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Active Done Task', parentId: storyId });
      const task1Id = task1Res.body.id;

      const task2Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Trashed Task', parentId: storyId });
      const task2Id = task2Res.body.id;

      // Seed the active task as DONE: no HTTP route sets DONE outside verify
      // (CGLAB-377). The trash/archive below is what runs the parent sync.
      await storage.updateItem(task1Id, { status: Status.DONE } as any);

      // Trash the second task
      await agent().delete(`/items/${task2Id}`);

      // Parent should be DONE — trashed child should be ignored
      const parentRes = await agent().get(`/items/${storyId}`);
      expect(parentRes.body.status).toBe(Status.DONE);
    });

    it('should treat parent as DONE when all active children are DONE and one is ARCHIVED', async () => {
      const storyRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent with Archived Child' });
      const storyId = storyRes.body.id;

      const task1Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Active Done Task 2', parentId: storyId });
      const task1Id = task1Res.body.id;

      const task2Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Archived Task', parentId: storyId });
      const task2Id = task2Res.body.id;

      // Seed the active task as DONE: no HTTP route sets DONE outside verify
      // (CGLAB-377). The trash/archive below is what runs the parent sync.
      await storage.updateItem(task1Id, { status: Status.DONE } as any);

      // Archive the second task
      await agent().put(`/items/${task2Id}`).set('x-agenfk-ui', '1').send({ status: Status.ARCHIVED });

      // Parent should be DONE — archived child should be ignored
      const parentRes = await agent().get(`/items/${storyId}`);
      expect(parentRes.body.status).toBe(Status.DONE);
    });

    it('should not advance parent to DONE if active (non-trashed/archived) children remain incomplete', async () => {
      const storyRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent with Mixed Children' });
      const storyId = storyRes.body.id;

      const task1Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Done Task', parentId: storyId });
      const task1Id = task1Res.body.id;

      const task2Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Still TODO Task', parentId: storyId });

      const task3Res = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Trashed Task 2', parentId: storyId });
      const task3Id = task3Res.body.id;

      // Seed task1 as DONE (no HTTP route sets DONE outside verify, CGLAB-377)
      await storage.updateItem(task1Id, { status: Status.DONE } as any);

      // Trash task3
      await agent().delete(`/items/${task3Id}`);

      // task2 is still TODO — parent should NOT be DONE
      const parentRes = await agent().get(`/items/${storyId}`);
      expect(parentRes.body.status).not.toBe(Status.DONE);
    });

    it('should archive and unarchive an item', async () => {
      const createRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Archive Me', description: 'D' });
      const id = createRes.body.id;

      // Archive
      const archiveRes = await agent().put(`/items/${id}`).send({ status: Status.ARCHIVED });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.status).toBe(Status.ARCHIVED);

      // Unarchive
      const unarchiveRes = await agent().put(`/items/${id}`).send({ status: Status.TODO });
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.status).toBe(Status.TODO);
    });

    it('should trash an item (soft delete)', async () => {
      const createRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Delete Me', description: 'D' });
      const id = createRes.body.id;

      const delRes = await agent().delete(`/items/${id}`);
      expect(delRes.status).toBe(204);

      // Should still be fetchable by ID
      const getRes = await agent().get(`/items/${id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe(Status.TRASHED);

      // Should NOT appear in general items list by default
      const listRes = await agent().get('/items');
      const found = listRes.body.find((i: any) => i.id === id);
      expect(found).toBeUndefined();
    });

    it('should trash all archived items', async () => {
      // Create an archived item
      const itemRes = await agent()
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Archived Task', status: Status.ARCHIVED });
      const id = itemRes.body.id;

      const trashRes = await agent()
        .post('/items/trash-archived')
        .send({ projectId });
      
      expect(trashRes.status).toBe(200);
      expect(trashRes.body.count).toBeGreaterThan(0);

      const getRes = await agent().get(`/items/${id}`);
      expect(getRes.body.status).toBe(Status.TRASHED);
    });
  });
});

// ── JIRA Integration Tests ────────────────────────────────────────────────────

describe('JIRA Integration', () => {
  // Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075):
  // the paths are lazy so the beforeEach re-arm (after vi.resetAllMocks) is
  // always effective, and the token/config cycles can never touch the real
  // ~/.agenfk under any runner (env overrides only work while libuv follows
  // the JS env — not under Stryker's threads pool).
  const jiraSandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-server-jira-'));
  fs.mkdirSync(path.join(jiraSandboxHome, '.agenfk'), { recursive: true });
  const jiraTokenPath = () => path.join(os.homedir(), '.agenfk', 'jira-token.json');
  const jiraConfigPath = () => path.join(os.homedir(), '.agenfk', 'config.json');

  const testToken = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    cloudId: 'test-cloud-id',
    cloudUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
  };

  let originalConfig: string | null = null;

  beforeEach(async () => {
    // Clean token
    if (fs.existsSync(jiraTokenPath())) fs.unlinkSync(jiraTokenPath());
    // Backup config and remove JIRA section
    if (fs.existsSync(jiraConfigPath())) {
      originalConfig = fs.readFileSync(jiraConfigPath(), 'utf8');
      const cfg = JSON.parse(originalConfig);
      delete cfg.jira;
      fs.writeFileSync(jiraConfigPath(), JSON.stringify(cfg, null, 2));
    } else {
      originalConfig = null;
    }
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
    delete process.env.JIRA_REDIRECT_URI;
    oauthStateStore.clear();
    clearJiraValidationCache();
    vi.resetAllMocks();
    // Re-arm: resetAllMocks reverted the homedir mock to its factory default.
    vi.mocked(os.homedir).mockReturnValue(jiraSandboxHome);
  });

  afterEach(() => {
    if (fs.existsSync(jiraTokenPath())) fs.unlinkSync(jiraTokenPath());
    // Restore config
    if (originalConfig !== null) {
      fs.writeFileSync(jiraConfigPath(), originalConfig);
    }
  });

  // ── mapJiraTypeToAgEnFK ──────────────────────────────────────────────────
  describe('mapJiraTypeToAgEnFK', () => {
    it('maps Epic → EPIC', () => expect(mapJiraTypeToAgEnFK('Epic')).toBe('EPIC'));
    it('maps Story → STORY', () => expect(mapJiraTypeToAgEnFK('Story')).toBe('STORY'));
    it('maps Bug → BUG', () => expect(mapJiraTypeToAgEnFK('Bug')).toBe('BUG'));
    it('maps Task → TASK', () => expect(mapJiraTypeToAgEnFK('Task')).toBe('TASK'));
    it('maps Sub-task → TASK', () => expect(mapJiraTypeToAgEnFK('Sub-task')).toBe('TASK'));
    it('maps unknown → TASK', () => expect(mapJiraTypeToAgEnFK('Custom Type')).toBe('TASK'));
  });

  // ── GET /jira/status ─────────────────────────────────────────────────────
  describe('GET /jira/status', () => {
    it('returns configured:false and connected:false when no config or token', async () => {
      const res = await agent().get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
      expect(res.body.connected).toBe(false);
      expect(res.body.message).toContain('agenfk jira setup');
    });

    it('returns configured:true and connected:false when config present but no token', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      const res = await agent().get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
    });

    it('returns connected:true with cloudId and email when token is valid', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      // Mock the /myself validation call
      axios.mockResolvedValueOnce({ data: { emailAddress: 'test@example.com' } });
      const res = await agent().get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(true);
      expect(res.body.cloudId).toBe('test-cloud-id');
      expect(res.body.email).toBe('test@example.com');
    });

    it('returns connected:false with reason when token is expired and refresh fails', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      const err401 = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      // Validation call to /myself returns 401
      axios.mockRejectedValueOnce(err401);
      // refreshJiraToken uses axios.post — mock that to fail too
      axios.post.mockRejectedValueOnce(new Error('Refresh failed'));
      const res = await agent().get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
      expect(res.body.reason).toBe('token_expired');
    });

    it('returns connected:true when Atlassian API is unreachable (network error)', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      // Network error (no response property)
      axios.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await agent().get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
    });
  });

  // ── GET /jira/oauth/authorize ────────────────────────────────────────────
  describe('GET /jira/oauth/authorize', () => {
    it('returns 503 with CLI hint when JIRA not configured', async () => {
      const res = await agent().get('/jira/oauth/authorize');
      expect(res.status).toBe(503);
      expect(res.body.configured).toBe(false);
      expect(res.body.command).toBe('agenfk jira setup');
    });

    it('redirects to Atlassian when configured via env vars', async () => {
      process.env.JIRA_CLIENT_ID = 'test-client-id';
      process.env.JIRA_CLIENT_SECRET = 'test-secret';
      const res = await agent().get('/jira/oauth/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('auth.atlassian.com/authorize');
      expect(res.headers.location).toContain('client_id=test-client-id');
      // CGLAB-361: no PKCE on the wire. See the dedicated tests below.
      expect(res.headers.location).not.toContain('code_challenge');
      // The state entry survives: it is CSRF protection, not PKCE bookkeeping.
      expect(oauthStateStore.size).toBe(1);
    });

    // ── CGLAB-361 ──────────────────────────────────────────────────────────
    // Atlassian's consent endpoint began returning HTTP 500
    // ({"failedToLoad":true,"error":{"category":"generic"}},
    // atl-traceid 4477e8158284433a8af8ecf8974f56bc) for an authorize request
    // carrying code_challenge. Measured 2026-09-22 by single-variable
    // experiment against live Atlassian: same client_id, scopes, redirect_uri
    // and prompt=consent, with ONLY the PKCE parameters removed, the consent
    // screen returns 200 and renders, Accept issues a code, and that code
    // exchanges for an access_token + refresh_token with no code_verifier.
    //
    // Atlassian's docs still say 3LO supports PKCE S256 alongside client
    // authentication, so this is a workaround for an unconfirmed regression on
    // their side, NOT a claim that PKCE was wrong here. Do not restore it
    // without re-running that experiment; these tests exist so that a silent
    // restore fails loudly.
    it('sends no PKCE parameters to Atlassian (CGLAB-361)', async () => {
      process.env.JIRA_CLIENT_ID = 'test-client-id';
      process.env.JIRA_CLIENT_SECRET = 'test-secret';
      const res = await agent().get('/jira/oauth/authorize');
      expect(res.status).toBe(302);
      const url = new URL(res.headers.location);
      expect(`${url.origin}${url.pathname}`).toBe('https://auth.atlassian.com/authorize');
      expect(url.searchParams.has('code_challenge')).toBe(false);
      expect(url.searchParams.has('code_challenge_method')).toBe(false);
      // Pin the whole request shape, so anything re-added shows up here.
      expect([...url.searchParams.keys()].sort()).toEqual(
        ['audience', 'client_id', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'],
      );
    });

    it('reads config from ~/.agenfk/config.json jira key', async () => {
      const cfg = fs.existsSync(jiraConfigPath())
        ? JSON.parse(fs.readFileSync(jiraConfigPath(), 'utf8'))
        : {};
      cfg.jira = { clientId: 'cfg-client-id', clientSecret: 'cfg-secret' };
      fs.writeFileSync(jiraConfigPath(), JSON.stringify(cfg, null, 2));

      const res = await agent().get('/jira/oauth/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('cfg-client-id');
    });
  });

  // ── GET /jira/oauth/callback ─────────────────────────────────────────────
  describe('GET /jira/oauth/callback', () => {
    it('redirects with error when error param present', async () => {
      const res = await agent().get('/jira/oauth/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=error');
    });

    it('redirects with error when code missing', async () => {
      const res = await agent().get('/jira/oauth/callback?state=abc');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=error');
      expect(res.headers.location).toContain('missing_params');
    });

    it('redirects with error for unknown state', async () => {
      const res = await agent().get('/jira/oauth/callback?code=abc&state=unknown-state');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('invalid_state');
    });

    it('completes OAuth flow and saves token', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';

      // Populate pkce store with a known state
      oauthStateStore.set('test-state', { expiresAt: Date.now() + 60000 });

      const axios = (await import('axios')).default as any;
      // Mock: token exchange
      axios.post.mockResolvedValueOnce({ data: { access_token: 'at', refresh_token: 'rt' } });
      // Mock: accessible resources
      axios.get.mockResolvedValueOnce({ data: [{ id: 'cloud-123', url: 'https://test.atlassian.net', name: 'Test Cloud' }] });
      // Mock: /myself
      axios.get.mockResolvedValueOnce({ data: { emailAddress: 'user@test.com' } });

      const res = await agent().get('/jira/oauth/callback?code=auth-code&state=test-state');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=connected');
      expect(fs.existsSync(jiraTokenPath())).toBe(true);
      const saved = JSON.parse(fs.readFileSync(jiraTokenPath(), 'utf8'));
      expect(saved.cloudId).toBe('cloud-123');
      expect(saved.email).toBe('user@test.com');
    });

    // With PKCE gone, the state nonce is the callback's only protection, so
    // each of its properties is pinned: issued by /authorize, single-use, and
    // refused once expired.
    it('accepts the state /authorize issued, exactly once (CGLAB-361)', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      const auth = await agent().get('/jira/oauth/authorize');
      const state = new URL(auth.headers.location).searchParams.get('state')!;

      const axios = (await import('axios')).default as any;
      axios.post.mockResolvedValueOnce({ data: { access_token: 'at', refresh_token: 'rt' } });
      axios.get.mockResolvedValueOnce({ data: [{ id: 'cloud-123', url: 'https://test.atlassian.net', name: 'Test Cloud' }] });
      axios.get.mockResolvedValueOnce({ data: { emailAddress: 'user@test.com' } });

      const callback = `/jira/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`;
      const first = await agent().get(callback);
      expect(first.headers.location).toContain('jira=connected');

      const replay = await agent().get(callback);
      expect(replay.headers.location).toContain('invalid_state');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('rejects an expired state without exchanging the code (CGLAB-361)', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      oauthStateStore.set('stale-state', { expiresAt: Date.now() - 1 });
      const axios = (await import('axios')).default as any;

      const res = await agent().get('/jira/oauth/callback?code=auth-code&state=stale-state');
      expect(res.headers.location).toContain('invalid_state');
      expect(oauthStateStore.has('stale-state')).toBe(false);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('exchanges the code without a code_verifier (CGLAB-361)', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      oauthStateStore.set('test-state', { expiresAt: Date.now() + 60000 });

      const axios = (await import('axios')).default as any;
      axios.post.mockResolvedValueOnce({ data: { access_token: 'at', refresh_token: 'rt' } });
      axios.get.mockResolvedValueOnce({ data: [{ id: 'cloud-123', url: 'https://test.atlassian.net', name: 'Test Cloud' }] });
      axios.get.mockResolvedValueOnce({ data: { emailAddress: 'user@test.com' } });

      const res = await agent().get('/jira/oauth/callback?code=auth-code&state=test-state');
      expect(res.headers.location).toContain('jira=connected');

      const [url, body] = axios.post.mock.calls[0];
      expect(url).toBe('https://auth.atlassian.com/oauth/token');
      expect(body).not.toHaveProperty('code_verifier');
      // The confidential-client exchange is otherwise unchanged.
      expect(body).toMatchObject({
        grant_type: 'authorization_code',
        client_id: 'cid',
        client_secret: 'csec',
        code: 'auth-code',
      });
    });
  });

  // ── GET /jira/projects ───────────────────────────────────────────────────
  describe('GET /jira/projects', () => {
    it('returns 401 when not connected', async () => {
      const res = await agent().get('/jira/projects');
      expect(res.status).toBe(401);
    });

    it('returns project list when connected', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      axios.mockResolvedValueOnce({
        data: { values: [{ id: '10001', key: 'PROJ', name: 'My Project', projectTypeKey: 'software' }] },
      });
      const res = await agent().get('/jira/projects');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].key).toBe('PROJ');
    });
  });

  // ── GET /jira/projects/:key/issues ───────────────────────────────────────
  describe('GET /jira/projects/:key/issues', () => {
    it('returns 401 when not connected', async () => {
      const res = await agent().get('/jira/projects/PROJ/issues');
      expect(res.status).toBe(401);
    });

    it('returns issues with mapped types', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      axios.mockResolvedValueOnce({
        data: {
          issues: [
            { id: '1', key: 'PROJ-1', fields: { summary: 'Fix bug', issuetype: { name: 'Bug' }, status: { name: 'Open' }, priority: { name: 'High' } } },
            { id: '2', key: 'PROJ-2', fields: { summary: 'New feature', issuetype: { name: 'Story' }, status: { name: 'Todo' }, priority: { name: 'Medium' } } },
            { id: '3', key: 'PROJ-3', fields: { summary: 'Big work', issuetype: { name: 'Epic' }, status: { name: 'Todo' }, priority: { name: 'Low' } } },
          ],
        },
      });
      const res = await agent().get('/jira/projects/PROJ/issues');
      expect(res.status).toBe(200);
      expect(res.body[0].mappedType).toBe('BUG');
      expect(res.body[1].mappedType).toBe('STORY');
      expect(res.body[2].mappedType).toBe('EPIC');
    });
  });

  // ── POST /jira/import ────────────────────────────────────────────────────
  describe('POST /jira/import', () => {
    it('returns 401 when not connected', async () => {
      const res = await agent()
        .post('/jira/import')
        .send({ projectId: 'p1', items: [{ issueKey: 'PROJ-1' }] });
      expect(res.status).toBe(401);
    });

    it('returns 400 when items array missing or empty', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const res = await agent().post('/jira/import').send({ projectId: 'p1' });
      expect(res.status).toBe(400);
    });

    it('imports issues and creates AgEnFK items', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const projRes = await agent().post('/projects').send({ name: 'JIRA Import Test' });
      const projectId = projRes.body.id;

      const axios = (await import('axios')).default as any;
      axios.mockResolvedValueOnce({
        data: {
          id: '1', key: 'PROJ-1',
          fields: { summary: 'Fix login bug', description: null, issuetype: { name: 'Bug' } },
        },
      });

      const res = await agent()
        .post('/jira/import')
        .send({ projectId, items: [{ issueKey: 'PROJ-1' }] });
      expect(res.status).toBe(200);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.imported[0].issueKey).toBe('PROJ-1');
      expect(res.body.errors).toHaveLength(0);

      const itemsRes = await agent().get(`/items?projectId=${projectId}`);
      const importedItem = itemsRes.body.find((i: any) => i.title.includes('PROJ-1'));
      expect(importedItem).toBeDefined();
      expect(importedItem.type).toBe('BUG');
    });

    it('records errors for failed issue fetches', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const projRes = await agent().post('/projects').send({ name: 'JIRA Err Test' });
      const projectId = projRes.body.id;

      const axios = (await import('axios')).default as any;
      axios.mockRejectedValueOnce(new Error('Network error'));

      const res = await agent()
        .post('/jira/import')
        .send({ projectId, items: [{ issueKey: 'PROJ-99' }] });
      expect(res.status).toBe(200);
      expect(res.body.imported).toHaveLength(0);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].issueKey).toBe('PROJ-99');
    });
  });

  // ── POST /jira/disconnect ────────────────────────────────────────────────
  describe('POST /jira/disconnect', () => {
    it('removes token file and returns disconnected:true', async () => {
      fs.writeFileSync(jiraTokenPath(), JSON.stringify(testToken));
      const res = await agent().post('/jira/disconnect');
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(fs.existsSync(jiraTokenPath())).toBe(false);
    });

    it('succeeds even when token file does not exist', async () => {
      const res = await agent().post('/jira/disconnect');
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
    });
  });

  // ── GET /api/telemetry/config ────────────────────────────────────────────
  describe('GET /api/telemetry/config', () => {
    it('returns installationId and telemetryEnabled', async () => {
      const res = await agent().get('/api/telemetry/config');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('installationId');
      expect(res.body).toHaveProperty('telemetryEnabled');
      expect(typeof res.body.telemetryEnabled).toBe('boolean');
    });

    it('installationId is a non-empty string or null', async () => {
      const res = await agent().get('/api/telemetry/config');
      const { installationId } = res.body;
      expect(installationId === null || typeof installationId === 'string').toBe(true);
      if (typeof installationId === 'string') {
        expect(installationId.length).toBeGreaterThan(0);
      }
    });
  });

  afterAll(() => {
    vi.mocked(os.homedir).mockRestore();
    try { fs.rmSync(jiraSandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

});
