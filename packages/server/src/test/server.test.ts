import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage, pkceStore, mapJiraTypeToAgenFK, clearJiraValidationCache } from '../server';
import { Status, ItemType, AgenFKItem } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./server-test-db.json');

describe('Server API', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  describe('GET /projects', () => {
    it('should return empty list initially', async () => {
      const res = await request(app).get('/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('PUT /projects/:id', () => {
    it('should update a project', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send({ name: 'P1' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/projects/${id}`)
        .send({ name: 'P1 Updated' });
      
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('P1 Updated');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await request(app)
        .put('/projects/none')
        .send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /projects/:id', () => {
    it('should delete a project', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send({ name: 'To Delete' });
      const id = createRes.body.id;

      const res = await request(app).delete(`/projects/${id}`);
      expect(res.status).toBe(204);

      const getRes = await request(app).get(`/projects/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe('GET /items', () => {
    it('should return empty items list', async () => {
      const res = await request(app).get('/items');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('Items Lifecycle', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await request(app).post('/projects').send({ name: 'Item Test' });
      projectId = res.body.id;
    });

    it('should create an item', async () => {
      const res = await request(app)
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

    it('should update an item status', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'To Update', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .send({ status: Status.IN_PROGRESS });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Status.IN_PROGRESS);
    });

    it('should block direct transition to DONE', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'No Cheat', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .send({ status: Status.DONE });
      
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('WORKFLOW VIOLATION');
    });

    it('should allow transition to DONE with internal token', async () => {
      // Find the token
      const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
      const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : 'dummy';
      
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Verify Me', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .set('x-agenfk-internal', token)
        .send({ status: Status.DONE });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Status.DONE);
    });

    it('should propagate status to parent', async () => {
      const storyRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent Story', description: 'D' });
      const storyId = storyRes.body.id;

      const taskRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Child Task', description: 'D', parentId: storyId });
      const taskId = taskRes.body.id;

      // Update child to IN_PROGRESS
      await request(app).put(`/items/${taskId}`).send({ status: Status.IN_PROGRESS });

      // Check parent
      const parentRes = await request(app).get(`/items/${storyId}`);
      expect(parentRes.body.status).toBe(Status.IN_PROGRESS);
    });

    it('should archive and unarchive an item', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Archive Me', description: 'D' });
      const id = createRes.body.id;

      // Archive
      const archiveRes = await request(app).put(`/items/${id}`).send({ status: Status.ARCHIVED });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.status).toBe(Status.ARCHIVED);

      // Unarchive
      const unarchiveRes = await request(app).put(`/items/${id}`).send({ status: Status.TODO });
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.status).toBe(Status.TODO);
    });

    it('should trash an item (soft delete)', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Delete Me', description: 'D' });
      const id = createRes.body.id;

      const delRes = await request(app).delete(`/items/${id}`);
      expect(delRes.status).toBe(204);

      // Should still be fetchable by ID
      const getRes = await request(app).get(`/items/${id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe(Status.TRASHED);

      // Should NOT appear in general items list by default
      const listRes = await request(app).get('/items');
      const found = listRes.body.find((i: any) => i.id === id);
      expect(found).toBeUndefined();
    });

    it('should trash all archived items', async () => {
      // Create an archived item
      const itemRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Archived Task', status: Status.ARCHIVED });
      const id = itemRes.body.id;

      const trashRes = await request(app)
        .post('/items/trash-archived')
        .send({ projectId });
      
      expect(trashRes.status).toBe(200);
      expect(trashRes.body.count).toBeGreaterThan(0);

      const getRes = await request(app).get(`/items/${id}`);
      expect(getRes.body.status).toBe(Status.TRASHED);
    });
  });
});

// ── JIRA Integration Tests ────────────────────────────────────────────────────

describe('JIRA Integration', () => {
  const jiraTokenPath = path.join(os.homedir(), '.agenfk', 'jira-token.json');
  const jiraConfigPath = path.join(os.homedir(), '.agenfk', 'config.json');

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
    if (fs.existsSync(jiraTokenPath)) fs.unlinkSync(jiraTokenPath);
    // Backup config and remove JIRA section
    if (fs.existsSync(jiraConfigPath)) {
      originalConfig = fs.readFileSync(jiraConfigPath, 'utf8');
      const cfg = JSON.parse(originalConfig);
      delete cfg.jira;
      fs.writeFileSync(jiraConfigPath, JSON.stringify(cfg, null, 2));
    } else {
      originalConfig = null;
    }
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
    delete process.env.JIRA_REDIRECT_URI;
    pkceStore.clear();
    clearJiraValidationCache();
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(jiraTokenPath)) fs.unlinkSync(jiraTokenPath);
    // Restore config
    if (originalConfig !== null) {
      fs.writeFileSync(jiraConfigPath, originalConfig);
    }
  });

  // ── mapJiraTypeToAgenFK ──────────────────────────────────────────────────
  describe('mapJiraTypeToAgenFK', () => {
    it('maps Epic → EPIC', () => expect(mapJiraTypeToAgenFK('Epic')).toBe('EPIC'));
    it('maps Story → STORY', () => expect(mapJiraTypeToAgenFK('Story')).toBe('STORY'));
    it('maps Bug → BUG', () => expect(mapJiraTypeToAgenFK('Bug')).toBe('BUG'));
    it('maps Task → TASK', () => expect(mapJiraTypeToAgenFK('Task')).toBe('TASK'));
    it('maps Sub-task → TASK', () => expect(mapJiraTypeToAgenFK('Sub-task')).toBe('TASK'));
    it('maps unknown → TASK', () => expect(mapJiraTypeToAgenFK('Custom Type')).toBe('TASK'));
  });

  // ── GET /jira/status ─────────────────────────────────────────────────────
  describe('GET /jira/status', () => {
    it('returns configured:false and connected:false when no config or token', async () => {
      const res = await request(app).get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
      expect(res.body.connected).toBe(false);
      expect(res.body.message).toContain('agenfk jira setup');
    });

    it('returns configured:true and connected:false when config present but no token', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      const res = await request(app).get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
    });

    it('returns connected:true with cloudId and email when token is valid', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      // Mock the /myself validation call
      axios.mockResolvedValueOnce({ data: { emailAddress: 'test@example.com' } });
      const res = await request(app).get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(true);
      expect(res.body.cloudId).toBe('test-cloud-id');
      expect(res.body.email).toBe('test@example.com');
    });

    it('returns connected:false with reason when token is expired and refresh fails', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      const err401 = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      // Validation call to /myself returns 401
      axios.mockRejectedValueOnce(err401);
      // refreshJiraToken uses axios.post — mock that to fail too
      axios.post.mockRejectedValueOnce(new Error('Refresh failed'));
      const res = await request(app).get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
      expect(res.body.reason).toBe('token_expired');
    });

    it('returns connected:true when Atlassian API is unreachable (network error)', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      // Network error (no response property)
      axios.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await request(app).get('/jira/status');
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
    });
  });

  // ── GET /jira/oauth/authorize ────────────────────────────────────────────
  describe('GET /jira/oauth/authorize', () => {
    it('returns 503 with CLI hint when JIRA not configured', async () => {
      const res = await request(app).get('/jira/oauth/authorize');
      expect(res.status).toBe(503);
      expect(res.body.configured).toBe(false);
      expect(res.body.command).toBe('agenfk jira setup');
    });

    it('redirects to Atlassian when configured via env vars', async () => {
      process.env.JIRA_CLIENT_ID = 'test-client-id';
      process.env.JIRA_CLIENT_SECRET = 'test-secret';
      const res = await request(app).get('/jira/oauth/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('auth.atlassian.com/authorize');
      expect(res.headers.location).toContain('client_id=test-client-id');
      expect(res.headers.location).toContain('code_challenge_method=S256');
      expect(pkceStore.size).toBe(1);
    });

    it('reads config from ~/.agenfk/config.json jira key', async () => {
      const cfg = fs.existsSync(jiraConfigPath)
        ? JSON.parse(fs.readFileSync(jiraConfigPath, 'utf8'))
        : {};
      cfg.jira = { clientId: 'cfg-client-id', clientSecret: 'cfg-secret' };
      fs.writeFileSync(jiraConfigPath, JSON.stringify(cfg, null, 2));

      const res = await request(app).get('/jira/oauth/authorize');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('cfg-client-id');
    });
  });

  // ── GET /jira/oauth/callback ─────────────────────────────────────────────
  describe('GET /jira/oauth/callback', () => {
    it('redirects with error when error param present', async () => {
      const res = await request(app).get('/jira/oauth/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=error');
    });

    it('redirects with error when code missing', async () => {
      const res = await request(app).get('/jira/oauth/callback?state=abc');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=error');
      expect(res.headers.location).toContain('missing_params');
    });

    it('redirects with error for unknown state', async () => {
      const res = await request(app).get('/jira/oauth/callback?code=abc&state=unknown-state');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('invalid_state');
    });

    it('completes OAuth flow and saves token', async () => {
      process.env.JIRA_CLIENT_ID = 'cid';
      process.env.JIRA_CLIENT_SECRET = 'csec';

      // Populate pkce store with a known state
      pkceStore.set('test-state', { codeVerifier: 'test-verifier', expiresAt: Date.now() + 60000 });

      const axios = (await import('axios')).default as any;
      // Mock: token exchange
      axios.post.mockResolvedValueOnce({ data: { access_token: 'at', refresh_token: 'rt' } });
      // Mock: accessible resources
      axios.get.mockResolvedValueOnce({ data: [{ id: 'cloud-123', url: 'https://test.atlassian.net', name: 'Test Cloud' }] });
      // Mock: /myself
      axios.get.mockResolvedValueOnce({ data: { emailAddress: 'user@test.com' } });

      const res = await request(app).get('/jira/oauth/callback?code=auth-code&state=test-state');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('jira=connected');
      expect(fs.existsSync(jiraTokenPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(jiraTokenPath, 'utf8'));
      expect(saved.cloudId).toBe('cloud-123');
      expect(saved.email).toBe('user@test.com');
    });
  });

  // ── GET /jira/projects ───────────────────────────────────────────────────
  describe('GET /jira/projects', () => {
    it('returns 401 when not connected', async () => {
      const res = await request(app).get('/jira/projects');
      expect(res.status).toBe(401);
    });

    it('returns project list when connected', async () => {
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const axios = (await import('axios')).default as any;
      axios.mockResolvedValueOnce({
        data: { values: [{ id: '10001', key: 'PROJ', name: 'My Project', projectTypeKey: 'software' }] },
      });
      const res = await request(app).get('/jira/projects');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].key).toBe('PROJ');
    });
  });

  // ── GET /jira/projects/:key/issues ───────────────────────────────────────
  describe('GET /jira/projects/:key/issues', () => {
    it('returns 401 when not connected', async () => {
      const res = await request(app).get('/jira/projects/PROJ/issues');
      expect(res.status).toBe(401);
    });

    it('returns issues with mapped types', async () => {
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
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
      const res = await request(app).get('/jira/projects/PROJ/issues');
      expect(res.status).toBe(200);
      expect(res.body[0].mappedType).toBe('BUG');
      expect(res.body[1].mappedType).toBe('STORY');
      expect(res.body[2].mappedType).toBe('EPIC');
    });
  });

  // ── POST /jira/import ────────────────────────────────────────────────────
  describe('POST /jira/import', () => {
    it('returns 401 when not connected', async () => {
      const res = await request(app)
        .post('/jira/import')
        .send({ projectId: 'p1', items: [{ issueKey: 'PROJ-1' }] });
      expect(res.status).toBe(401);
    });

    it('returns 400 when items array missing or empty', async () => {
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const res = await request(app).post('/jira/import').send({ projectId: 'p1' });
      expect(res.status).toBe(400);
    });

    it('imports issues and creates AgenFK items', async () => {
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const projRes = await request(app).post('/projects').send({ name: 'JIRA Import Test' });
      const projectId = projRes.body.id;

      const axios = (await import('axios')).default as any;
      axios.mockResolvedValueOnce({
        data: {
          id: '1', key: 'PROJ-1',
          fields: { summary: 'Fix login bug', description: null, issuetype: { name: 'Bug' } },
        },
      });

      const res = await request(app)
        .post('/jira/import')
        .send({ projectId, items: [{ issueKey: 'PROJ-1' }] });
      expect(res.status).toBe(200);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.imported[0].issueKey).toBe('PROJ-1');
      expect(res.body.errors).toHaveLength(0);

      const itemsRes = await request(app).get(`/items?projectId=${projectId}`);
      const importedItem = itemsRes.body.find((i: any) => i.title.includes('PROJ-1'));
      expect(importedItem).toBeDefined();
      expect(importedItem.type).toBe('BUG');
    });

    it('records errors for failed issue fetches', async () => {
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const projRes = await request(app).post('/projects').send({ name: 'JIRA Err Test' });
      const projectId = projRes.body.id;

      const axios = (await import('axios')).default as any;
      axios.mockRejectedValueOnce(new Error('Network error'));

      const res = await request(app)
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
      fs.writeFileSync(jiraTokenPath, JSON.stringify(testToken));
      const res = await request(app).post('/jira/disconnect');
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(fs.existsSync(jiraTokenPath)).toBe(false);
    });

    it('succeeds even when token file does not exist', async () => {
      const res = await request(app).post('/jira/disconnect');
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
    });
  });

  // ── GET /api/telemetry/config ────────────────────────────────────────────
  describe('GET /api/telemetry/config', () => {
    it('returns installationId and telemetryEnabled', async () => {
      const res = await request(app).get('/api/telemetry/config');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('installationId');
      expect(res.body).toHaveProperty('telemetryEnabled');
      expect(typeof res.body.telemetryEnabled).toBe('boolean');
    });

    it('installationId is a non-empty string or null', async () => {
      const res = await request(app).get('/api/telemetry/config');
      const { installationId } = res.body;
      expect(installationId === null || typeof installationId === 'string').toBe(true);
      if (typeof installationId === 'string') {
        expect(installationId.length).toBeGreaterThan(0);
      }
    });
  });
});
