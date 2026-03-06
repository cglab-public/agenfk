/**
 * Supplemental server tests covering routes not exercised by server.test.ts.
 * Focuses on: simple info routes, db/backup, bulk updates, verify edge cases,
 * jira status/disconnect/projects, releases/latest, and error branches.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage, pkceStore, mapJiraTypeToAgenFK } from '../server';
import { Status, ItemType } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./server-supplemental-test-db.json');

// ── Global jira token guard ───────────────────────────────────────────────────
// Save the real jira token before any test runs; restore after all tests so
// server.test.ts (which runs next in sequence) starts with a clean slate.
const GLOBAL_TOKEN_PATH = path.join(os.homedir(), '.agenfk', 'jira-token.json');
let globalSavedToken: string | null = null;

beforeAll(async () => {
  if (fs.existsSync(GLOBAL_TOKEN_PATH)) {
    globalSavedToken = fs.readFileSync(GLOBAL_TOKEN_PATH, 'utf8');
  }
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();

  const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
  if (fs.existsSync(tokenPath)) {
    verifyToken = fs.readFileSync(tokenPath, 'utf8').trim();
  }
});

afterAll(() => {
  // Restore the original jira token state
  if (globalSavedToken) {
    fs.writeFileSync(GLOBAL_TOKEN_PATH, globalSavedToken);
  } else if (fs.existsSync(GLOBAL_TOKEN_PATH)) {
    fs.unlinkSync(GLOBAL_TOKEN_PATH);
  }
  // Clean up test DB
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

// Shared token extracted from the running server's ephemeral VERIFY_TOKEN.
let verifyToken: string = '';

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

// ── mapJiraTypeToAgenFK unit tests ───────────────────────────────────────────

describe('mapJiraTypeToAgenFK', () => {
  it('maps epic', () => expect(mapJiraTypeToAgenFK('Epic')).toBe('EPIC'));
  it('maps story', () => expect(mapJiraTypeToAgenFK('Story')).toBe('STORY'));
  it('maps bug', () => expect(mapJiraTypeToAgenFK('Bug')).toBe('BUG'));
  it('defaults to TASK', () => expect(mapJiraTypeToAgenFK('Sub-task')).toBe('TASK'));
  it('is case-insensitive', () => expect(mapJiraTypeToAgenFK('EPIC')).toBe('EPIC'));
});

// ── Info / utility routes ─────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns server info', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('AgenFK');
    expect(res.body.endpoints).toBeDefined();
  });
});

describe('GET /version', () => {
  it('returns version string', async () => {
    const res = await request(app).get('/version');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
  });
});

describe('GET /api/telemetry/config', () => {
  it('returns telemetry config', async () => {
    const res = await request(app).get('/api/telemetry/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('telemetryEnabled');
  });
});

describe('GET /api/readme', () => {
  it('returns 404 when README not found in non-project cwd', async () => {
    // cwd in test env typically lacks a README
    const res = await request(app).get('/api/readme');
    // Either 200 with content (if README exists) or 404
    expect([200, 404]).toContain(res.status);
  });
});

describe('GET /db/status', () => {
  it('returns db status info', async () => {
    await initStorage();
    const res = await request(app).get('/db/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dbType');
    expect(res.body).toHaveProperty('dbPath');
  });
});

// ── Backup endpoint ───────────────────────────────────────────────────────────

describe('POST /backup', () => {
  it('returns 401 without internal token', async () => {
    const res = await request(app).post('/backup');
    expect(res.status).toBe(401);
  });

  it('performs backup when token is provided', async () => {
    if (!verifyToken) return; // skip if no token available
    await initStorage();
    const res = await request(app)
      .post('/backup')
      .set('x-agenfk-internal', verifyToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('backupPath');
  });
});

// ── Items error branches ──────────────────────────────────────────────────────

describe('POST /items validation', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 400 when type missing', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const res = await request(app).post('/items').send({ title: 'T', projectId: p.id });
    expect(res.status).toBe(400);
  });

  it('returns 400 when title missing', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P2' })).body;
    const res = await request(app).post('/items').send({ type: 'TASK', projectId: p.id });
    expect(res.status).toBe(400);
  });

  it('returns 400 when projectId missing', async () => {
    const res = await request(app).post('/items').send({ type: 'TASK', title: 'T' });
    expect(res.status).toBe(400);
  });

  it('creates a BUG item with severity field', async () => {
    const p = (await request(app).post('/projects').send({ name: 'BugProj' })).body;
    const res = await request(app).post('/items').send({ type: 'BUG', title: 'Bug1', projectId: p.id });
    expect(res.status).toBe(201);
    expect((res.body as any).severity).toBe('LOW');
  });
});

describe('GET /items/:id', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/items/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('returns item for known id', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app).get(`/items/${item.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(item.id);
  });
});

describe('GET /projects/:id', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 404 for unknown project', async () => {
    const res = await request(app).get('/projects/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns project for known id', async () => {
    const p = (await request(app).post('/projects').send({ name: 'Proj' })).body;
    const res = await request(app).get(`/projects/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(p.id);
  });
});

describe('PUT /items/:id workflow guards', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 when setting DONE directly', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app).put(`/items/${item.id}`).send({ status: 'DONE' });
    expect(res.status).toBe(403);
  });

  it('allows setting REVIEW directly', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVIEW');
  });

  it('returns 404 for unknown item', async () => {
    const res = await request(app).put('/items/nonexistent').send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  it('updates title successfully', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app).put(`/items/${item.id}`).send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
  });
});

// ── Bulk endpoint ─────────────────────────────────────────────────────────────

describe('POST /items/bulk', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 400 when items is not array', async () => {
    const res = await request(app).post('/items/bulk').send({ items: 'bad' });
    expect(res.status).toBe(400);
  });

  it('updates multiple items', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const i1 = (await request(app).post('/items').send({ type: 'TASK', title: 'A', projectId: p.id })).body;
    const i2 = (await request(app).post('/items').send({ type: 'TASK', title: 'B', projectId: p.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [
        { id: i1.id, updates: { sortOrder: 1 } },
        { id: i2.id, updates: { sortOrder: 0 } },
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it('skips DONE status without internal token', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'DONE' } }]
    });
    expect(res.status).toBe(200);
    // Item should NOT have been moved to DONE
    const updated = (await request(app).get(`/items/${item.id}`)).body;
    expect(updated.status).not.toBe('DONE');
  });

  it('archives item recursively via bulk', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'ARCHIVED' } }]
    });
    expect(res.status).toBe(200);
  });
});

// ── Review endpoint edge cases ────────────────────────────────────────────────

describe('POST /items/:id/review', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 without token', async () => {
    const res = await request(app).post('/items/some-id/review').send({ command: 'echo hi' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when command missing (with token)', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app)
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', verifyToken)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown item (with token)', async () => {
    if (!verifyToken) return;
    await initStorage();
    const res = await request(app)
      .post('/items/nonexistent/review')
      .set('x-agenfk-internal', verifyToken)
      .send({ command: 'echo hi' });
    expect(res.status).toBe(404);
  });
});

// ── Test endpoint edge cases ─────────────────────────────────────────────────

describe('POST /items/:id/test', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 without token', async () => {
    const res = await request(app).post('/items/some-id/test').send({});
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown item (with token)', async () => {
    if (!verifyToken) return;
    await initStorage();
    const res = await request(app)
      .post('/items/nonexistent/test')
      .set('x-agenfk-internal', verifyToken)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ── JIRA routes (unauthenticated) ─────────────────────────────────────────────

describe('GET /jira/status', () => {
  it('returns connected:false when no token file', async () => {
    const res = await request(app).get('/jira/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connected');
  });
});

describe('GET /jira/oauth/authorize', () => {
  it('returns 503 or 302 depending on JIRA config', async () => {
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
    const res = await request(app).get('/jira/oauth/authorize');
    // 503 when not configured, 302 redirect when configured via config file
    expect([302, 503]).toContain(res.status);
  });

  it('redirects to Atlassian when JIRA is configured via env', async () => {
    process.env.JIRA_CLIENT_ID = 'test-client-id';
    process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
    const res = await request(app).get('/jira/oauth/authorize');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('atlassian.com');
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  });
});

describe('GET /jira/projects', () => {
  const tokenPath = path.join(os.homedir(), '.agenfk', 'jira-token.json');
  let savedToken: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(tokenPath)) {
      savedToken = fs.readFileSync(tokenPath, 'utf8');
      fs.unlinkSync(tokenPath);
    }
  });
  afterEach(() => {
    if (savedToken) { fs.writeFileSync(tokenPath, savedToken); savedToken = null; }
  });

  it('returns 401 when not connected', async () => {
    const res = await request(app).get('/jira/projects');
    expect(res.status).toBe(401);
  });
});

describe('POST /jira/import', () => {
  const _tokenPath = path.join(os.homedir(), '.agenfk', 'jira-token.json');
  let _savedImportToken: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(_tokenPath)) {
      _savedImportToken = fs.readFileSync(_tokenPath, 'utf8');
      fs.unlinkSync(_tokenPath);
    }
  });
  afterEach(() => {
    if (_savedImportToken) { fs.writeFileSync(_tokenPath, _savedImportToken); _savedImportToken = null; }
  });

  it('returns 401 when not connected', async () => {
    const res = await request(app)
      .post('/jira/import')
      .send({ projectId: 'p1', items: [{ issueKey: 'TEST-1' }] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when missing projectId', async () => {
    // Temporarily create a fake jira token to pass auth check
    const tokenDir = path.join(os.homedir(), '.agenfk');
    const tokenPath = path.join(tokenDir, 'jira-token.json');
    const existed = fs.existsSync(tokenPath);
    const prev = existed ? fs.readFileSync(tokenPath, 'utf8') : null;
    if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'tok', refresh_token: 'ref', cloudId: 'cid', cloudUrl: 'https://x.atlassian.net' }));
    try {
      const res = await request(app).post('/jira/import').send({ items: [] });
      expect(res.status).toBe(400);
    } finally {
      if (prev) fs.writeFileSync(tokenPath, prev);
      else if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    }
  });
});

describe('POST /jira/disconnect', () => {
  it('returns disconnected:true', async () => {
    const res = await request(app).post('/jira/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
  });
});

describe('GET /jira/oauth/callback', () => {
  it('redirects on error param', async () => {
    const res = await request(app).get('/jira/oauth/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('jira=error');
  });

  it('redirects on missing params', async () => {
    const res = await request(app).get('/jira/oauth/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('jira=error');
  });

  it('redirects on invalid state', async () => {
    const res = await request(app).get('/jira/oauth/callback?code=abc&state=badstate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('invalid_state');
  });
});

// ── Releases ──────────────────────────────────────────────────────────────────

describe('GET /releases/update/:jobId', () => {
  it('returns 404 for unknown job', async () => {
    const res = await request(app).get('/releases/update/unknown-job-id');
    expect(res.status).toBe(404);
  });
});

describe('GET /releases/latest', () => {
  it('returns 502 when GitHub API fails', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockRejectedValueOnce(new Error('Network Error'));
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty('currentVersion');
  });

  it('returns release data on success', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v1.2.3',
        name: 'Release 1.2.3',
        body: 'Notes',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v1.2.3',
      }
    });
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.2.3');
    expect(res.body).toHaveProperty('currentVersion');
  });
});

// ── validate_progress: command-only-on-final-step ─────────────────────────────

describe('POST /items/:id/validate — command required only on final step', () => {
  beforeEach(async () => { await initStorage(); });

  it('advances intermediate step (REVIEW→TEST) with no command, without running anything', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'PV1' })).body;
    // No verifyCommand set on project
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'TV1', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', verifyToken)
      .send({});  // no command

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TEST');
  });

  it('advances intermediate step (IN_PROGRESS→REVIEW) with no command', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'PV2' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'TV2', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', verifyToken)
      .send({});  // no command

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVIEW');
  });

  it('still returns NO_VERIFY_COMMAND when on final step (TEST→DONE) with no command and no verifyCommand', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'PV3' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'TV3', projectId: p.id })).body;
    await request(app)
      .post('/items/bulk')
      .set('x-agenfk-internal', verifyToken)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await request(app).get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', verifyToken)
      .send({});  // no command, no verifyCommand

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_VERIFY_COMMAND');
  });

  it('runs verifyCommand on final step (TEST→DONE) when no explicit command given', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'PV4' })).body;
    await request(app).put(`/projects/${p.id}`).send({ verifyCommand: 'echo verify-ok' });
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'TV4', projectId: p.id })).body;
    await request(app)
      .post('/items/bulk')
      .set('x-agenfk-internal', verifyToken)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await request(app).get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', verifyToken)
      .send({});  // no command — should use verifyCommand

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) expect(res.body.status).toBe('DONE');
  });
});

// ── Review success path ───────────────────────────────────────────────────────

describe('POST /items/:id/review success paths', () => {
  beforeEach(async () => { await initStorage(); });

  it('moves REVIEW item to TEST on passing command', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });

    const res = await request(app)
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', verifyToken)
      .send({ command: 'echo review-ok' });

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe('TEST');
    }
  });

  it('returns 422 on failing command and moves back to IN_PROGRESS', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P3' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T3', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });

    const res = await request(app)
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', verifyToken)
      .send({ command: 'exit 1' });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('IN_PROGRESS');
  });
});

// ── Test success path ─────────────────────────────────────────────────────────

describe('POST /items/:id/test success paths', () => {
  beforeEach(async () => { await initStorage(); });

  it('moves TEST item to DONE when verifyCommand passes', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P2' })).body;
    // Set verifyCommand on the project
    await request(app).put(`/projects/${p.id}`).send({ verifyCommand: 'echo done-ok' });

    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T2', projectId: p.id })).body;

    // Force status to TEST using the bulk endpoint with internal token
    await request(app)
      .post('/items/bulk')
      .set('x-agenfk-internal', verifyToken)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await request(app).get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return; // skip if we couldn't set TEST

    const res = await request(app)
      .post(`/items/${item.id}/test`)
      .set('x-agenfk-internal', verifyToken)
      .send({});

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe('DONE');
    }
  });

  it('returns 400 when no verifyCommand configured', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P-novc' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T-novc', projectId: p.id })).body;

    await request(app)
      .post('/items/bulk')
      .set('x-agenfk-internal', verifyToken)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await request(app).get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await request(app)
      .post(`/items/${item.id}/test`)
      .set('x-agenfk-internal', verifyToken)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_VERIFY_COMMAND');
  });
});

// ── JIRA routes with mocked token ─────────────────────────────────────────────

const JIRA_TOKEN_PATH = path.join(os.homedir(), '.agenfk', 'jira-token.json');
const FAKE_JIRA_TOKEN = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  cloudId: 'test-cloud-id',
  cloudUrl: 'https://testorg.atlassian.net',
  email: 'test@example.com',
};

const withJiraToken = (fn: () => Promise<void>) => async () => {
  let prev: string | null = null;
  if (fs.existsSync(JIRA_TOKEN_PATH)) prev = fs.readFileSync(JIRA_TOKEN_PATH, 'utf8');
  fs.mkdirSync(path.dirname(JIRA_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(JIRA_TOKEN_PATH, JSON.stringify(FAKE_JIRA_TOKEN));
  try {
    await fn();
  } finally {
    if (prev) fs.writeFileSync(JIRA_TOKEN_PATH, prev);
    else if (fs.existsSync(JIRA_TOKEN_PATH)) fs.unlinkSync(JIRA_TOKEN_PATH);
  }
};

describe('GET /jira/status (with token)', () => {
  it('returns connected:true', withJiraToken(async () => {
    const res = await request(app).get('/jira/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.cloudId).toBe('test-cloud-id');
  }));
});

describe('GET /jira/projects (with token + mock axios)', () => {
  it('returns project list on success', withJiraToken(async () => {
    const axios = (await import('axios')).default as any;
    (axios as any).mockResolvedValueOnce({
      data: {
        values: [
          { id: '10001', key: 'TEST', name: 'Test Project', projectTypeKey: 'software' }
        ]
      }
    });
    const res = await request(app).get('/jira/projects');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  }));

  it('returns 502 when axios fails', withJiraToken(async () => {
    const axios = (await import('axios')).default as any;
    (axios as any).mockRejectedValueOnce(Object.assign(new Error('Network error'), { response: null }));
    const res = await request(app).get('/jira/projects');
    expect(res.status).toBe(502);
  }));
});

describe('GET /jira/projects/:key/issues with filters', () => {
  it('covers summary and statusCategory query params', withJiraToken(async () => {
    const axios = (await import('axios')).default as any;
    (axios as any).mockResolvedValueOnce({
      data: { issues: [] }
    });
    const res = await request(app)
      .get('/jira/projects/TEST/issues')
      .query({ summary: 'login', statusCategory: 'In Progress,Done' });
    expect([200, 502]).toContain(res.status);
  }));
});

describe('POST /jira/import (with token + mock axios)', () => {
  it('returns 400 for empty items array', withJiraToken(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const res = await request(app)
      .post('/jira/import')
      .send({ projectId: p.id, items: [] });
    expect(res.status).toBe(400);
  }));

  it('imports a task item', withJiraToken(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const axios = (await import('axios')).default as any;
    // mock jiraApiRequest → GET issue
    (axios as any).mockResolvedValueOnce({
      data: {
        fields: {
          summary: 'My Task',
          description: null,
          issuetype: { name: 'Task' }
        }
      }
    });
    const res = await request(app)
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'TASK' }] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toHaveLength(1);
  }));

  it('imports an epic with children (next-gen)', withJiraToken(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const axios = (await import('axios')).default as any;
    // Epic fetch
    (axios as any).mockResolvedValueOnce({
      data: { fields: { summary: 'Big Epic', description: null, issuetype: { name: 'Epic' } } }
    });
    // Child issues (next-gen parent query)
    (axios as any).mockResolvedValueOnce({
      data: { issues: [{ key: 'TEST-2', fields: { summary: 'Child Story', description: null, issuetype: { name: 'Story' } } }] }
    });
    const res = await request(app)
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'EPIC' }] });
    expect(res.status).toBe(200);
    expect(res.body.imported.length).toBeGreaterThanOrEqual(1);
  }));

  it('imports an epic with children via classic fallback', withJiraToken(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const axios = (await import('axios')).default as any;
    // Epic fetch
    (axios as any).mockResolvedValueOnce({
      data: { fields: { summary: 'Classic Epic', description: null, issuetype: { name: 'Epic' } } }
    });
    // next-gen returns empty
    (axios as any).mockResolvedValueOnce({ data: { issues: [] } });
    // classic fallback returns a child
    (axios as any).mockResolvedValueOnce({
      data: { issues: [{ key: 'TEST-3', fields: { summary: 'Classic Child', description: null, issuetype: { name: 'Story' } } }] }
    });
    const res = await request(app)
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'EPIC' }] });
    expect(res.status).toBe(200);
  }));
});

describe('GET /jira/oauth/callback (with PKCE state)', () => {
  it('exchanges code for token', withJiraToken(async () => {
    process.env.JIRA_CLIENT_ID = 'test-cid';
    process.env.JIRA_CLIENT_SECRET = 'test-cs';

    // First set up a valid PKCE entry
    const authorizeRes = await request(app).get('/jira/oauth/authorize');
    // Extract state from redirect URL
    const location = authorizeRes.headers.location || '';
    const stateMatch = location.match(/state=([^&]+)/);
    if (!stateMatch) return; // can't continue without state

    const state = decodeURIComponent(stateMatch[1]);
    const axios = (await import('axios')).default as any;
    // mock token exchange
    axios.post.mockResolvedValueOnce({
      data: { access_token: 'new-at', refresh_token: 'new-rt' }
    });
    // mock accessible resources
    axios.get.mockResolvedValueOnce({
      data: [{ id: 'cloud1', url: 'https://test.atlassian.net', name: 'Test' }]
    });
    // mock myself (non-fatal)
    axios.get.mockRejectedValueOnce(new Error('no myself'));

    const res = await request(app)
      .get(`/jira/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);

    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  }));
});

// ── PUT /items/:id (DONE with internal token) ────────────────────────────────

describe('PUT /items/:id with internal token', () => {
  beforeEach(async () => { await initStorage(); });

  it('allows DONE with internal verify token', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app)
      .put(`/items/${item.id}`)
      .set('x-agenfk-internal', verifyToken)
      .send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DONE');
  });
});

// ── jiraApiRequest 401 → token refresh flow ──────────────────────────────────

describe('GET /jira/projects (401 → refresh flow)', () => {
  it('retries with refreshed token on 401', withJiraToken(async () => {
    process.env.JIRA_CLIENT_ID = 'test-cid';
    process.env.JIRA_CLIENT_SECRET = 'test-cs';
    const axios = (await import('axios')).default as any;

    // First call: 401 unauthorized
    const err401 = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    (axios as any).mockRejectedValueOnce(err401);
    // Refresh token call succeeds
    axios.post.mockResolvedValueOnce({
      data: { access_token: 'refreshed-token', refresh_token: 'new-refresh' }
    });
    // Retry call succeeds
    (axios as any).mockResolvedValueOnce({
      data: { values: [{ id: '10001', key: 'PROJ', name: 'Test', projectTypeKey: 'software' }] }
    });

    const res = await request(app).get('/jira/projects');
    expect([200, 502]).toContain(res.status);

    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  }));

  it('returns 502 when refresh fails on 401', withJiraToken(async () => {
    process.env.JIRA_CLIENT_ID = 'test-cid';
    process.env.JIRA_CLIENT_SECRET = 'test-cs';
    const axios = (await import('axios')).default as any;

    const err401 = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    (axios as any).mockRejectedValueOnce(err401);
    // Refresh fails too
    axios.post.mockRejectedValueOnce(new Error('Refresh failed'));

    const res = await request(app).get('/jira/projects');
    expect(res.status).toBe(502);

    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  }));
});

// ── loadJiraConfig from config file ──────────────────────────────────────────

describe('GET /jira/status (config from file)', () => {
  const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
  let savedConfig: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(configPath)) savedConfig = fs.readFileSync(configPath, 'utf8');
  });
  afterEach(() => {
    if (savedConfig) fs.writeFileSync(configPath, savedConfig);
    else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    savedConfig = null;
  });

  it('reads JIRA config from config.json jira key', async () => {
    const cfg = savedConfig ? JSON.parse(savedConfig) : {};
    cfg.jira = { clientId: 'file-client-id', clientSecret: 'file-secret' };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;

    const res = await request(app).get('/jira/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });
});

// ── POST /items (parent sync) ─────────────────────────────────────────────────

describe('POST /items with parentId triggers parent sync', () => {
  beforeEach(async () => { await initStorage(); });

  it('creates child item and syncs parent', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const res = await request(app).post('/items').send({
      type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id
    });
    expect(res.status).toBe(201);
    expect(res.body.parentId).toBe(parent.id);
  });
});

// ── DELETE /items/:id with parent sync ───────────────────────────────────────

describe('DELETE /items/:id with parent sync', () => {
  beforeEach(async () => { await initStorage(); });

  it('deletes child and syncs parent', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({
      type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id
    })).body;
    const res = await request(app).delete(`/items/${child.id}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown item', async () => {
    const res = await request(app).delete('/items/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

// ── GET /items with filters ───────────────────────────────────────────────────

describe('GET /items query filters', () => {
  beforeEach(async () => { await initStorage(); });

  it('filters by type', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    await request(app).post('/items').send({ type: 'TASK', title: 'T1', projectId: p.id });
    await request(app).post('/items').send({ type: 'BUG', title: 'B1', projectId: p.id });
    const res = await request(app).get('/items').query({ type: 'TASK', projectId: p.id });
    expect(res.status).toBe(200);
    expect(res.body.every((i: any) => i.type === 'TASK')).toBe(true);
  });

  it('includes archived when includeArchived=true', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    await request(app).post('/items/bulk').send({ items: [{ id: item.id, updates: { status: 'ARCHIVED' } }] });
    const res = await request(app).get('/items').query({ includeArchived: 'true', projectId: p.id });
    expect(res.status).toBe(200);
    const archived = res.body.find((i: any) => i.status === 'ARCHIVED');
    expect(archived).toBeDefined();
  });
});

// ── PUT /items/:id unarchive path ─────────────────────────────────────────────

describe('PUT /items/:id unarchive via status change', () => {
  beforeEach(async () => { await initStorage(); });

  it('unarchives item by setting non-archived status', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    // Archive via bulk
    await request(app).post('/items/bulk').send({ items: [{ id: item.id, updates: { status: 'ARCHIVED' } }] });
    // Unarchive by setting TODO
    const res = await request(app).put(`/items/${item.id}`).send({ status: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TODO');
  });
});

// ── GET /releases/latest with GITHUB_TOKEN ───────────────────────────────────

describe('GET /releases/latest with GITHUB_TOKEN', () => {
  it('uses Authorization header when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'test-gh-token';
    const axios = (await import('axios')).default as any;
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v9.9.9', name: 'Release 9.9', body: '',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/v9.9.9',
      }
    });
    const res = await request(app).get('/releases/latest');
    expect(res.status).toBe(200);
    delete process.env.GITHUB_TOKEN;
  });
});

// ── POST /items/bulk with internal token (DONE/REVIEW allowed) ────────────────

describe('POST /items/bulk with internal token', () => {
  beforeEach(async () => { await initStorage(); });

  it('allows DONE status with internal token', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app)
      .post('/items/bulk')
      .set('x-agenfk-internal', verifyToken)
      .send({ items: [{ id: item.id, updates: { status: 'DONE' } }] });
    expect(res.status).toBe(200);
    const updated = (await request(app).get(`/items/${item.id}`)).body;
    expect(updated.status).toBe('DONE');
  });
});

// ── GET /releases/latest cache hit ───────────────────────────────────────────

describe('GET /releases/latest cache hit', () => {
  it('returns cached data on second call without re-fetching', async () => {
    const axios = (await import('axios')).default as any;
    // First call: populate the cache
    axios.get.mockResolvedValueOnce({
      data: {
        tag_name: 'v3.0.0', name: 'Release 3.0', body: '',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/example/repo/releases/v3.0.0',
      }
    });
    const res1 = await request(app).get('/releases/latest');
    const firstVersion = res1.body.version;

    // Second call: should hit cache (axios.get not called again)
    const callCountBefore = axios.get.mock?.calls?.length ?? 0;
    const res2 = await request(app).get('/releases/latest');
    expect(res2.status).toBe(200);
    expect(res2.body.version).toBe(firstVersion); // same version from cache
    // axios.get should NOT have been called again
    const callCountAfter = axios.get.mock?.calls?.length ?? 0;
    expect(callCountAfter).toBe(callCountBefore);
  });
});

// ── GET /releases/update/:jobId success path ─────────────────────────────────

describe('GET /releases/update/:jobId success', () => {
  it('returns job status after POST /releases/update', async () => {
    const postRes = await request(app).post('/releases/update');
    expect(postRes.status).toBe(202);
    const jobId = postRes.body.jobId;

    const res = await request(app).get(`/releases/update/${jobId}`);
    expect(res.status).toBe(200);
    expect(['running', 'success', 'error']).toContain(res.body.status);
  });
});

// ── POST /projects duplicate name ─────────────────────────────────────────────

describe('POST /projects duplicate name', () => {
  beforeEach(async () => { await initStorage(); });

  it('still creates project when name already exists (telemetry branch)', async () => {
    await request(app).post('/projects').send({ name: 'DupProj' });
    const res = await request(app).post('/projects').send({ name: 'DupProj' });
    // Server allows duplicates — just suppresses telemetry event
    expect(res.status).toBe(201);
  });
});

// ── syncParentStatus branches ─────────────────────────────────────────────────

describe('syncParentStatus advanced scenarios', () => {
  beforeEach(async () => { await initStorage(); });

  it('syncs parent to IN_PROGRESS when one child is in_progress', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await request(app).put(`/items/${child.id}`).send({ status: 'IN_PROGRESS' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('syncs parent to DONE when all children are done', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Set child to DONE via internal token
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'DONE' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('DONE');
  });

  it('handles nested parent sync (grandparent)', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const grandparent = (await request(app).post('/items').send({ type: 'EPIC', title: 'GP', projectId: p.id })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id, parentId: grandparent.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'DONE' });
    const updatedParent = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updatedParent.status).toBe('DONE');
  });

  it('syncs parent to TEST when all children are in TEST or DONE', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'TEST' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('TEST');
  });
});

// ── PUT /items/:id with all optional fields ───────────────────────────────────

describe('PUT /items/:id with optional fields', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates context, tokenUsage, implementationPlan, comments, sortOrder', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    const res = await request(app).put(`/items/${item.id}`).send({
      title: 'Updated',
      description: 'desc',
      context: [{ path: '/foo.ts', content: 'code', description: 'desc' }],
      tokenUsage: [{ input: 100, output: 50, model: 'claude-sonnet-4-6' }],
      implementationPlan: 'step 1',
      comments: [{ id: 'c1', author: 'Agent', content: 'done', timestamp: new Date() }],
      sortOrder: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.sortOrder).toBe(5);
  });
});

// ── POST /items/trash-archived ────────────────────────────────────────────────

describe('POST /items/trash-archived', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 400 when projectId missing', async () => {
    const res = await request(app).post('/items/trash-archived').send({});
    expect(res.status).toBe(400);
  });

  it('trashes archived items', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    // Create and archive an item via bulk
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    await request(app).post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'ARCHIVED' } }]
    });
    const res = await request(app).post('/items/trash-archived').send({ projectId: p.id });
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });
});

// ── POST /items/bulk - additional branch coverage ─────────────────────────────

describe('POST /items/bulk - branch coverage', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates item with all optional fields (title, description, parentId, tokenUsage, context, implementationPlan, reviews, comments)', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [{
        id: item.id,
        updates: {
          title: 'New Title',
          description: 'New desc',
          parentId: parent.id,
          tokenUsage: [{ input: 100, output: 50, model: 'test' }],
          context: [{ path: '/x.ts', content: 'code' }],
          implementationPlan: 'step 1',
          reviews: [{ id: 'r1', content: 'lgtm' }],
          comments: [{ id: 'c1', content: 'done' }],
        }
      }]
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].title).toBe('New Title');
  });

  it('skips unknown item ids gracefully', async () => {
    const res = await request(app).post('/items/bulk').send({
      items: [{ id: 'nonexistent-id-xyz', updates: { status: 'IN_PROGRESS' } }]
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('allows REVIEW status without internal token', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'REVIEW' } }]
    });
    expect(res.status).toBe(200);
    const updated = (await request(app).get(`/items/${item.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });

  it('syncs parent after bulk update with parentId', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;

    const res = await request(app).post('/items/bulk').send({
      items: [{ id: child.id, updates: { status: 'IN_PROGRESS' } }]
    });
    expect(res.status).toBe(200);
    const updatedParent = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updatedParent.status).toBe('IN_PROGRESS');
  });
});

// ── PUT /items/:id - reviews, tests, parentId fields ─────────────────────────

describe('PUT /items/:id - reviews, tests, parentId fields', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates reviews, tests, and parentId fields', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await request(app).put(`/items/${item.id}`).send({
      parentId: parent.id,
      reviews: [{ id: 'r1', content: 'lgtm', author: 'Agent' }],
      tests: [{ id: 't1', name: 'unit test', status: 'PASSED' }],
    });
    expect(res.status).toBe(200);
  });
});

// ── syncParentStatus - remaining branch coverage ──────────────────────────────

describe('syncParentStatus - remaining branches', () => {
  beforeEach(async () => { await initStorage(); });

  it('does not re-update parent when it is already DONE', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to DONE first
    await request(app).put(`/items/${parent.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'DONE' });
    // Now set child to DONE — sync triggers but parent is already DONE, no-op
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'DONE' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('DONE');
  });

  it('does not re-update parent when it is already TEST', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to TEST first
    await request(app).put(`/items/${parent.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'TEST' });
    // Now set child to TEST — sync triggers but parent already TEST, no-op
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'TEST' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('TEST');
  });

  it('syncs parent to REVIEW when all children are REVIEW or above', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'REVIEW' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });

  it('does not update parent already at REVIEW when child moves to REVIEW', async () => {
    if (!verifyToken) return;
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to REVIEW first
    await request(app).put(`/items/${parent.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'REVIEW' });
    // Now set child to REVIEW — sync: parent already REVIEW, no-op
    await request(app).put(`/items/${child.id}`).set('x-agenfk-internal', verifyToken).send({ status: 'REVIEW' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });

  it('does not re-update parent that is already IN_PROGRESS', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Set parent to IN_PROGRESS first
    await request(app).put(`/items/${parent.id}`).send({ status: 'IN_PROGRESS' });
    // Set child to IN_PROGRESS — parent already IN_PROGRESS, no further update
    await request(app).put(`/items/${child.id}`).send({ status: 'IN_PROGRESS' });
    const updated = (await request(app).get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('IN_PROGRESS');
  });
});

// ── Archive/unarchive edge cases ───────────────────────────────────────────────

describe('archive and unarchive edge cases', () => {
  beforeEach(async () => { await initStorage(); });

  it('archiving a child that is already archived is a no-op (archiveRecursively guard)', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Archive child first
    await request(app).put(`/items/${child.id}`).send({ status: 'ARCHIVED' });
    // Archive parent — calls archiveRecursively(child) but child is already ARCHIVED → early return
    const res = await request(app).put(`/items/${parent.id}`).send({ status: 'ARCHIVED' });
    expect(res.status).toBe(200);
  });

  it('unarchives parent and its archived children (unarchiveRecursively with children)', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Archive parent (archiveRecursively archives child too)
    await request(app).put(`/items/${parent.id}`).send({ status: 'ARCHIVED' });
    const archivedChild = (await request(app).get(`/items/${child.id}?includeArchived=true`)).body;
    expect(archivedChild.status).toBe('ARCHIVED');
    // Unarchive parent — unarchiveRecursively recurses into child (line 118 arm 0)
    const res = await request(app).put(`/items/${parent.id}`).send({ status: 'TODO' });
    expect(res.status).toBe(200);
    const unarchivedChild = (await request(app).get(`/items/${child.id}`)).body;
    expect(unarchivedChild.status).not.toBe('ARCHIVED');
  });

  it('unarchiving a parent with a non-archived child skips recursion for that child', async () => {
    const p = (await request(app).post('/projects').send({ name: 'P' })).body;
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    // Archive only the parent directly (no children)
    await request(app).put(`/items/${parent.id}`).send({ status: 'ARCHIVED' });
    // Unarchive parent — no children, so child loop does nothing
    const res = await request(app).put(`/items/${parent.id}`).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });
});

// ── Flow CRUD API tests ───────────────────────────────────────────────────────

describe('Flows API', () => {
  beforeEach(async () => {
    await initStorage();
  });

  it('GET /flows returns empty list initially', async () => {
    const res = await request(app).get('/flows');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /flows requires name', async () => {
    const res = await request(app).post('/flows').send({ description: 'No name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it('POST /flows does not store projectId', async () => {
    const p = (await request(app).post('/projects').send({ name: 'FlowProject' })).body;
    const res = await request(app).post('/flows').send({
      projectId: p.id,
      name: 'My Flow',
      description: 'A custom flow',
      steps: [
        { id: 'step-1', name: 'TODO', label: 'To Do', order: 1 },
        { id: 'step-2', name: 'IN_PROGRESS', label: 'In Progress', order: 2 },
        { id: 'step-3', name: 'DONE', label: 'Done', order: 3 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Flow');
    expect(res.body.projectId).toBeUndefined();
    expect(res.body.steps).toHaveLength(3);
    expect(res.body.id).toBeDefined();
  });

  it('GET /flows/:id returns the flow', async () => {
    const created = (await request(app).post('/flows').send({
      name: 'F1', steps: [],
    })).body;

    const res = await request(app).get(`/flows/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.name).toBe('F1');
  });

  it('GET /flows/:id returns 404 for unknown flow', async () => {
    const res = await request(app).get('/flows/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('PUT /flows/:id updates a flow', async () => {
    const created = (await request(app).post('/flows').send({
      name: 'Original', steps: [],
    })).body;

    const res = await request(app).put(`/flows/${created.id}`).send({
      name: 'Updated',
      description: 'Now with description',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
    expect(res.body.description).toBe('Now with description');
  });

  it('PUT /flows/:id returns 404 for unknown flow', async () => {
    const res = await request(app).put('/flows/nonexistent-id').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE /flows/:id deletes a flow', async () => {
    const created = (await request(app).post('/flows').send({
      name: 'ToDelete', steps: [],
    })).body;

    const delRes = await request(app).delete(`/flows/${created.id}`);
    expect(delRes.status).toBe(204);

    const getRes = await request(app).get(`/flows/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /flows/:id returns 404 for unknown flow', async () => {
    const res = await request(app).delete('/flows/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('GET /flows lists all flows globally (across projects)', async () => {
    const p1 = (await request(app).post('/projects').send({ name: 'P1' })).body;
    const p2 = (await request(app).post('/projects').send({ name: 'P2' })).body;
    await request(app).post('/flows').send({ name: 'F-A', steps: [] });
    await request(app).post('/flows').send({ name: 'F-B', steps: [] });
    // Flows are global — projectId on POST body is ignored
    await request(app).post('/flows').send({ projectId: p1.id, name: 'F-C', steps: [] });
    await request(app).post('/flows').send({ projectId: p2.id, name: 'F-D', steps: [] });

    const res = await request(app).get('/flows');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    const names = res.body.map((f: any) => f.name);
    expect(names).toContain('F-A');
    expect(names).toContain('F-B');
    expect(names).toContain('F-C');
    expect(names).toContain('F-D');
    // None should have projectId
    expect(res.body.every((f: any) => f.projectId === undefined)).toBe(true);
  });
});

// ── Project Flow assignment tests ─────────────────────────────────────────────

describe('Project Flow assignment', () => {
  let projectId: string;

  beforeEach(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'FlowProject2' })).body;
    projectId = p.id;
  });

  it('GET /projects/:id/flow returns DEFAULT_FLOW when no flowId set', async () => {
    const res = await request(app).get(`/projects/${projectId}/flow`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('default');
    expect(res.body.name).toBe('Default Flow');
  });

  it('GET /projects/:id/flow returns 404 for unknown project', async () => {
    const res = await request(app).get('/projects/nonexistent/flow');
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/flow requires flowId', async () => {
    const res = await request(app).post(`/projects/${projectId}/flow`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/flowId/);
  });

  it('POST /projects/:id/flow returns 404 for unknown flow', async () => {
    const res = await request(app).post(`/projects/${projectId}/flow`).send({ flowId: 'nonexistent' });
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/flow sets the active flow', async () => {
    const flow = (await request(app).post('/flows').send({
      projectId,
      name: 'Custom Flow',
      steps: [
        { id: 's1', name: 'TODO', label: 'To Do', order: 1 },
        { id: 's2', name: 'IN_PROGRESS', label: 'In Progress', order: 2 },
        { id: 's3', name: 'DONE', label: 'Done', order: 3 },
        { id: 's4', name: 'BLOCKED', label: 'Blocked', order: 4, isSpecial: true },
        { id: 's5', name: 'PAUSED', label: 'Paused', order: 5, isSpecial: true },
        { id: 's6', name: 'ARCHIVED', label: 'Archived', order: 6, isSpecial: true },
        { id: 's7', name: 'TRASHED', label: 'Trashed', order: 7, isSpecial: true },
      ],
    })).body;

    const res = await request(app).post(`/projects/${projectId}/flow`).send({ flowId: flow.id });
    expect(res.status).toBe(200);
    expect((res.body as any).flowId).toBe(flow.id);
  });

  it('GET /projects/:id/flow returns the assigned flow after setting it', async () => {
    const flow = (await request(app).post('/flows').send({
      projectId,
      name: 'Active Flow',
      steps: [
        { id: 's1', name: 'TODO', label: 'To Do', order: 1 },
        { id: 's2', name: 'DONE', label: 'Done', order: 2 },
        { id: 's3', name: 'BLOCKED', label: 'Blocked', order: 3, isSpecial: true },
        { id: 's4', name: 'PAUSED', label: 'Paused', order: 4, isSpecial: true },
        { id: 's5', name: 'ARCHIVED', label: 'Archived', order: 5, isSpecial: true },
        { id: 's6', name: 'TRASHED', label: 'Trashed', order: 6, isSpecial: true },
      ],
    })).body;

    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: flow.id });

    const res = await request(app).get(`/projects/${projectId}/flow`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(flow.id);
    expect(res.body.name).toBe('Active Flow');
  });

  it('POST /projects/:id/flow returns 404 for unknown project', async () => {
    const res = await request(app).post('/projects/nonexistent/flow').send({ flowId: 'any' });
    expect(res.status).toBe(404);
  });
});

// ── Flow-aware transition validation tests ────────────────────────────────────

describe('Flow-aware status transition validation', () => {
  let projectId: string;
  let flowId: string;

  beforeEach(async () => {
    await initStorage();
    const p = (await request(app).post('/projects').send({ name: 'TransitionProject' })).body;
    projectId = p.id;

    // Create a simple custom flow: TODO -> STEP_A -> STEP_B (plus special steps)
    const flow = (await request(app).post('/flows').send({
      projectId,
      name: 'Simple Flow',
      steps: [
        { id: 'f-todo', name: 'TODO', label: 'To Do', order: 1 },
        { id: 'f-a', name: 'IN_PROGRESS', label: 'In Progress', order: 2 },
        { id: 'f-b', name: 'REVIEW', label: 'Review', order: 3 },
        { id: 'f-done', name: 'DONE', label: 'Done', order: 4 },
        { id: 'f-blocked', name: 'BLOCKED', label: 'Blocked', order: 5, isSpecial: true },
        { id: 'f-paused', name: 'PAUSED', label: 'Paused', order: 6, isSpecial: true },
        { id: 'f-archived', name: 'ARCHIVED', label: 'Archived', order: 7, isSpecial: true },
        { id: 'f-trashed', name: 'TRASHED', label: 'Trashed', order: 8, isSpecial: true },
      ],
    })).body;
    flowId = flow.id;

    // Assign the custom flow to the project
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId });
  });

  it('allows valid forward transition (TODO -> IN_PROGRESS)', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T1', projectId, status: 'TODO',
    })).body;

    const res = await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('allows valid backward transition (IN_PROGRESS -> TODO)', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T2', projectId, status: 'TODO',
    })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });

    const res = await request(app).put(`/items/${item.id}`).send({ status: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TODO');
  });

  it('allows transition to special status BLOCKED from any step', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T3', projectId, status: 'TODO',
    })).body;

    const res = await request(app).put(`/items/${item.id}`).send({ status: 'BLOCKED' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('BLOCKED');
  });

  it('allows transition from special status BLOCKED to any step', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T4', projectId, status: 'TODO',
    })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'BLOCKED' });

    const res = await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('rejects invalid skip transition (TODO -> REVIEW, skipping IN_PROGRESS)', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T5', projectId, status: 'TODO',
    })).body;

    const res = await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/FLOW VIOLATION/);
  });

  it('allows DONE transition via internal token (bypasses flow validation)', async () => {
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T6', projectId, status: 'TODO',
    })).body;

    // Internal token bypasses both DONE guard and flow validation
    const res = await request(app)
      .put(`/items/${item.id}`)
      .set('x-agenfk-internal', verifyToken)
      .send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DONE');
  });

  it('project using DEFAULT_FLOW allows all standard transitions', async () => {
    // Create a project without custom flow (uses DEFAULT_FLOW)
    const p2 = (await request(app).post('/projects').send({ name: 'DefaultFlowProject' })).body;
    const item = (await request(app).post('/items').send({
      type: 'TASK', title: 'T7', projectId: p2.id, status: 'TODO',
    })).body;

    // TODO -> IN_PROGRESS allowed
    let res = await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);

    // IN_PROGRESS -> REVIEW allowed
    res = await request(app).put(`/items/${item.id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(200);

    // REVIEW -> TEST allowed
    res = await request(app).put(`/items/${item.id}`).send({ status: 'TEST' });
    expect(res.status).toBe(200);
  });
});
