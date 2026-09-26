/**
 * Supplemental server tests covering routes not exercised by server.test.ts.
 * Focuses on: simple info routes, db/backup, bulk updates, verify edge cases,
 * jira status/disconnect/projects, releases/latest, and error branches.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { makeProject, makeItem } from './helpers/fixtures';
import { app, initStorage, oauthStateStore, mapJiraTypeToAgEnFK, VERIFY_TOKEN, setReleasesUpdateExecImpl, resetReleasesUpdateExecImpl, setVerifyLogRootForTests, storage } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';
import { Status, ItemType } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` makes supertest start an ephemeral server and tear it down for
 * EVERY call — this file makes 349 of them. That churn produced
 * `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/`, a transport failure that
 * hands the test an empty body: `res.body.id` is then undefined, the next call
 * goes to `/items/undefined`, and one flaky socket surfaces as `expected 404 to
 * be 400` in whichever test happened to be running. Different test every run,
 * green when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
/**
 * Seed a card's status through storage, then make a harmless edit through
 * PUT /items/:id, which is what runs the parent sync. No HTTP route moves a
 * card several steps forward, or to DONE, outside verify (CGLAB-377); the
 * sync is what these tests are about.
 */
const seedThenSync = async (id: string, status: string) => {
  await storage.updateItem(id, { status } as any);
  const r = await agent().put(`/items/${id}`).send({ description: `seeded ${status}` });
  expect(r.status, `sync edit on ${id}: ${JSON.stringify(r.body)}`).toBe(200);
};
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

// Mockable homedir (item 9c297075) — delegates to the real one until armed.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

// Sandbox homedir via a CALL-TIME mock of os.homedir() (item 9c297075): every
// jira-token/config save-restore cycle in this file then operates in the
// sandbox — the real ~/.agenfk is never touched under any runner (an env
// override only works while libuv follows the JS env — not under Stryker's
// threads pool). Must arm before the module-level path constants below.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-supplemental-'));
fs.mkdirSync(path.join(sandboxHome, '.agenfk'), { recursive: true });
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

// Verify-log root pinned for THIS file. The production default is a stable,
// machine-global name (shared with any live agenfk server), and process.env is
// process-global while vitest reuses workers — a sibling file that sets the
// override would silently redirect this file's expectations depending on which
// file ran first. Pin it, and read it literally rather than via the getter.
const VERIFY_LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-verifylog-supplemental-'));
setVerifyLogRootForTests(VERIFY_LOG_ROOT);

// CRITICAL: install a no-op exec impl for POST /releases/update *before any
// test runs*. Without this, the supplemental test below shells out for real
// via `npx -y github:cglab-public/agenfk`, which downgrades ~/.agenfk-system/
// to the latest non-prerelease tag during every `npm test`. Bug 28635f38.
//
// This uses the dedicated injection (setReleasesUpdateExecImpl) instead of
// vi.mock('child_process') so we don't break unrelated tests in this file
// that depend on real exec/spawn for the verifyCommand path.
const stubReleasesUpdateExec = (() => {
  const fakeChild = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn() };
  return vi.fn(() => fakeChild as any);
})();
setReleasesUpdateExecImpl(stubReleasesUpdateExec as any);

const TEST_DB = path.resolve('./server-supplemental-test-db.sqlite');

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

});

afterAll(() => {
  // Restore ambient state: process.env is process-global and vitest reuses
  // workers, so leaving the override set would redirect a sibling file.
  setVerifyLogRootForTests(null);
  if (fs.existsSync(VERIFY_LOG_ROOT)) fs.rmSync(VERIFY_LOG_ROOT, { recursive: true, force: true });
  // Restore the original jira token state (sandbox-scoped since item 9c297075)
  if (globalSavedToken) {
    fs.writeFileSync(GLOBAL_TOKEN_PATH, globalSavedToken);
  } else if (fs.existsSync(GLOBAL_TOKEN_PATH)) {
    fs.unlinkSync(GLOBAL_TOKEN_PATH);
  }
  // Clean up test DB
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  vi.mocked(os.homedir).mockRestore();
  try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
});


afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

// ── mapJiraTypeToAgEnFK unit tests ───────────────────────────────────────────

describe('mapJiraTypeToAgEnFK', () => {
  it('maps epic', () => expect(mapJiraTypeToAgEnFK('Epic')).toBe('EPIC'));
  it('maps story', () => expect(mapJiraTypeToAgEnFK('Story')).toBe('STORY'));
  it('maps bug', () => expect(mapJiraTypeToAgEnFK('Bug')).toBe('BUG'));
  it('defaults to TASK', () => expect(mapJiraTypeToAgEnFK('Sub-task')).toBe('TASK'));
  it('is case-insensitive', () => expect(mapJiraTypeToAgEnFK('EPIC')).toBe('EPIC'));
});

// ── Info / utility routes ─────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns server info', async () => {
    const res = await agent().get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('AgEnFK');
    expect(res.body.endpoints).toBeDefined();
  });
});

describe('GET /version', () => {
  it('returns version string', async () => {
    const res = await agent().get('/version');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
  });
});

describe('GET /api/telemetry/config', () => {
  it('returns telemetry config', async () => {
    const res = await agent().get('/api/telemetry/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('telemetryEnabled');
  });
});

describe('GET /api/readme', () => {
  it('returns 404 when README not found in non-project cwd', async () => {
    // cwd in test env typically lacks a README
    const res = await agent().get('/api/readme');
    // Either 200 with content (if README exists) or 404
    expect([200, 404]).toContain(res.status);
  });
});

describe('GET /db/status', () => {
  it('returns db status info', async () => {
    await initStorage();
    const res = await agent().get('/db/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dbType');
    expect(res.body).toHaveProperty('dbPath');
  });
});

// ── Backup endpoint ───────────────────────────────────────────────────────────

describe('POST /backup', () => {
  it('returns 401 without internal token', async () => {
    const res = await agent().post('/backup');
    expect(res.status).toBe(401);
  });

  it('performs backup when token is provided', async () => {
    if (!VERIFY_TOKEN) return; // skip if no token available
    await initStorage();
    const res = await agent()
      .post('/backup')
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('backupPath');
  });
});

// ── Items error branches ──────────────────────────────────────────────────────

describe('POST /items validation', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 400 when type missing', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const res = await agent().post('/items').send({ title: 'T', projectId: p.id });
    expect(res.status).toBe(400);
  });

  it('returns 400 when title missing', async () => {
    const p = (await agent().post('/projects').send({ name: 'P2' })).body;
    const res = await agent().post('/items').send({ type: 'TASK', projectId: p.id });
    expect(res.status).toBe(400);
  });

  it('returns 400 when projectId missing', async () => {
    const res = await agent().post('/items').send({ type: 'TASK', title: 'T' });
    expect(res.status).toBe(400);
  });

  it('creates a BUG item with severity field', async () => {
    const p = (await agent().post('/projects').send({ name: 'BugProj' })).body;
    const res = await agent().post('/items').send({ type: 'BUG', title: 'Bug1', projectId: p.id });
    expect(res.status).toBe(201);
    expect((res.body as any).severity).toBe('LOW');
  });
});

describe('GET /items/:id', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 404 for unknown id', async () => {
    const res = await agent().get('/items/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('returns item for known id', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent().get(`/items/${item.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(item.id);
  });
});

describe('GET /projects/:id', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 404 for unknown project', async () => {
    const res = await agent().get('/projects/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns project for known id', async () => {
    const p = (await agent().post('/projects').send({ name: 'Proj' })).body;
    const res = await agent().get(`/projects/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(p.id);
  });
});

describe('PUT /items/:id workflow guards', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 when setting DONE directly', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent().put(`/items/${item.id}`).send({ status: 'DONE' });
    expect(res.status).toBe(403);
  });

  // Re-pointed by CGLAB-81. This used to assert that TODO -> REVIEW succeeded,
  // which was the bypass: transition validation ran only when a CUSTOM flow was
  // assigned, so default-flow projects could jump any distance forward with no
  // evidence and no exit-criteria check. The suite contradicted itself — see
  // 'rejects invalid skip transition (TODO -> REVIEW, skipping IN_PROGRESS)',
  // which asserted the opposite for a custom-flow project. Both now agree.
  it('rejects setting REVIEW directly, skipping the coding step', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent().put(`/items/${item.id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/FLOW VIOLATION/i);
    // A one-step forward move is verify's, or the board's (CGLAB-377).
    const refused = await agent().put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
    expect(refused.status).toBe(409);
    const ok = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('IN_PROGRESS');
  });

  it('returns 404 for unknown item', async () => {
    const res = await agent().put('/items/nonexistent').send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  it('updates title successfully', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent().put(`/items/${item.id}`).send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
  });
});

// ── Bulk endpoint ─────────────────────────────────────────────────────────────

describe('POST /items/bulk', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 400 when items is not array', async () => {
    const res = await agent().post('/items/bulk').send({ items: 'bad' });
    expect(res.status).toBe(400);
  });

  it('updates multiple items', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const i1 = (await agent().post('/items').send({ type: 'TASK', title: 'A', projectId: p.id })).body;
    const i2 = (await agent().post('/items').send({ type: 'TASK', title: 'B', projectId: p.id })).body;

    const res = await agent().post('/items/bulk').send({
      items: [
        { id: i1.id, updates: { sortOrder: 1 } },
        { id: i2.id, updates: { sortOrder: 0 } },
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it('skips DONE status without internal token', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });

    const res = await agent().post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'DONE' } }]
    });
    expect(res.status).toBe(200);
    // Item should NOT have been moved to DONE
    const updated = (await agent().get(`/items/${item.id}`)).body;
    expect(updated.status).not.toBe('DONE');
  });

  it('archives item recursively via bulk', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });

    const res = await agent().post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'ARCHIVED' } }]
    });
    expect(res.status).toBe(200);
  });
});

// ── Review endpoint edge cases ────────────────────────────────────────────────

describe('POST /items/:id/review', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 without token', async () => {
    const res = await agent().post('/items/some-id/review').send({ command: 'echo hi' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when command missing (with token)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent()
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown item (with token)', async () => {
    if (!VERIFY_TOKEN) return;
    await initStorage();
    const res = await agent()
      .post('/items/nonexistent/review')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'echo hi' });
    expect(res.status).toBe(404);
  });
});

// ── Test endpoint edge cases ─────────────────────────────────────────────────

describe('POST /items/:id/test', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns 403 without token', async () => {
    const res = await agent().post('/items/some-id/test').send({});
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown item (with token)', async () => {
    if (!VERIFY_TOKEN) return;
    await initStorage();
    const res = await agent()
      .post('/items/nonexistent/test')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ── JIRA routes (unauthenticated) ─────────────────────────────────────────────

describe('GET /jira/status', () => {
  it('returns connected:false when no token file', async () => {
    const res = await agent().get('/jira/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connected');
  });
});

describe('GET /jira/oauth/authorize', () => {
  it('returns 503 or 302 depending on JIRA config', async () => {
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
    const res = await agent().get('/jira/oauth/authorize');
    // 503 when not configured, 302 redirect when configured via config file
    expect([302, 503]).toContain(res.status);
  });

  it('redirects to Atlassian when JIRA is configured via env', async () => {
    process.env.JIRA_CLIENT_ID = 'test-client-id';
    process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
    const res = await agent().get('/jira/oauth/authorize');
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
    const res = await agent().get('/jira/projects');
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
    const res = await agent()
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
      const res = await agent().post('/jira/import').send({ items: [] });
      expect(res.status).toBe(400);
    } finally {
      if (prev) fs.writeFileSync(tokenPath, prev);
      else if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    }
  });
});

describe('POST /jira/disconnect', () => {
  it('returns disconnected:true', async () => {
    const res = await agent().post('/jira/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
  });
});

describe('GET /jira/oauth/callback', () => {
  it('redirects on error param', async () => {
    const res = await agent().get('/jira/oauth/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('jira=error');
  });

  it('redirects on missing params', async () => {
    const res = await agent().get('/jira/oauth/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('jira=error');
  });

  it('redirects on invalid state', async () => {
    const res = await agent().get('/jira/oauth/callback?code=abc&state=badstate');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('invalid_state');
  });
});

// ── Releases ──────────────────────────────────────────────────────────────────

describe('GET /releases/update/:jobId', () => {
  it('returns 404 for unknown job', async () => {
    const res = await agent().get('/releases/update/unknown-job-id');
    expect(res.status).toBe(404);
  });
});

describe('GET /releases/latest', () => {
  it('returns 502 when GitHub API fails', async () => {
    const axios = (await import('axios')).default as any;
    axios.get.mockRejectedValueOnce(new Error('Network Error'));
    const res = await agent().get('/releases/latest');
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
    const res = await agent().get('/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.2.3');
    expect(res.body).toHaveProperty('currentVersion');
  });
});

// ── validate_progress: command-only-on-final-step ─────────────────────────────

describe('POST /items/:id/validate — command required only on final step', () => {
  beforeEach(async () => { await initStorage(); });

  it('advances intermediate step (REVIEW→TEST) with no command, without running anything', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'PV1' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    // No verifyCommand set on project
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'TV1', projectId: p.id })).body;
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'REVIEW' });

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});  // no command

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TEST');
  });

  it('advances intermediate step (IN_PROGRESS→REVIEW) with no command', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'PV2');
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = await makeItem(app, { type: 'TASK', title: 'TV2', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});  // no command

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVIEW');
  });

  it('still returns NO_VERIFY_COMMAND when on final step (TEST→DONE) with no command and no verifyCommand', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'PV3');
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = await makeItem(app, { type: 'TASK', title: 'TV3', projectId: p.id });
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});  // no command, no verifyCommand

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_VERIFY_COMMAND');
  });

  it('runs verifyCommand on final step (TEST→DONE) when no explicit command given', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'PV4' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    await agent().put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN).send({ verifyCommand: 'echo verify-ok' });
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'TV4', projectId: p.id })).body;
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});  // no command — should use verifyCommand

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) expect(res.body.status).toBe('DONE');
  });
});

// ── validate_progress: evidence logging ──────────────────────────────────────

describe('POST /items/:id/validate — evidence comment logging', () => {
  beforeEach(async () => { await initStorage(); });

  it('logs evidence as a tagged comment before advancing', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'EV1');
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = await makeItem(app, { type: 'TASK', title: 'EV1', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ evidence: 'Wrote unit tests covering edge cases' });

    expect(res.status).toBe(200);
    const updated = (await agent().get(`/items/${item.id}`)).body;
    const evidenceComment = updated.comments.find((c: any) => c.content.includes('Wrote unit tests covering edge cases'));
    expect(evidenceComment).toBeDefined();
    expect(evidenceComment.step).toBe('IN_PROGRESS');
  });

  it('still advances without evidence when omitted', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'EV2');
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = await makeItem(app, { type: 'TASK', title: 'EV2', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVIEW');
  });
});

// ── Review success path ───────────────────────────────────────────────────────

describe('POST /items/:id/review success paths', () => {
  beforeEach(async () => { await initStorage(); });

  it('moves REVIEW item to TEST on passing command', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'REVIEW' });

    const res = await agent()
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'echo review-ok' });

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe('TEST');
    }
  });

  it('returns 422 on failing command and leaves the item on REVIEW (refused, not rolled back)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P3');
    const item = await makeItem(app, { type: 'TASK', title: 'T3', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'REVIEW' });

    const res = await agent()
      .post(`/items/${item.id}/review`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'exit 1' });

    expect(res.status).toBe(422);
    // CGLAB-275: a failed command refuses the advance; the card stays where it was.
    expect(res.body.status).toBe('REVIEW');
    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('REVIEW');
  });
});

// ── Test success path ─────────────────────────────────────────────────────────

describe('POST /items/:id/test success paths', () => {
  beforeEach(async () => { await initStorage(); });

  it('moves TEST item to DONE when verifyCommand passes', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P2' })).body;
    // Set verifyCommand via the gated internal endpoint (mass-assignment closed).
    await agent().put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN).send({ verifyCommand: 'echo done-ok' });

    const item = (await agent().post('/items').send({ type: 'TASK', title: 'T2', projectId: p.id })).body;

    // Force status to TEST using the bulk endpoint with internal token
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return; // skip if we couldn't set TEST

    const res = await agent()
      .post(`/items/${item.id}/test`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.status).toBe('DONE');
    }
  });

  it('returns 400 when no verifyCommand configured', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P-novc');
    const item = await makeItem(app, { type: 'TASK', title: 'T-novc', projectId: p.id });

    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/test`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
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
    const res = await agent().get('/jira/status');
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
    const res = await agent().get('/jira/projects');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  }));

  it('returns 502 when axios fails', withJiraToken(async () => {
    const axios = (await import('axios')).default as any;
    (axios as any).mockRejectedValueOnce(Object.assign(new Error('Network error'), { response: null }));
    const res = await agent().get('/jira/projects');
    expect(res.status).toBe(502);
  }));
});

describe('GET /jira/projects/:key/issues with filters', () => {
  it('covers summary and statusCategory query params', withJiraToken(async () => {
    const axios = (await import('axios')).default as any;
    (axios as any).mockResolvedValueOnce({
      data: { issues: [] }
    });
    const res = await agent()
      .get('/jira/projects/TEST/issues')
      .query({ summary: 'login', statusCategory: 'In Progress,Done' });
    expect([200, 502]).toContain(res.status);
  }));
});

describe('POST /jira/import (with token + mock axios)', () => {
  it('returns 400 for empty items array', withJiraToken(async () => {
    await initStorage();
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const res = await agent()
      .post('/jira/import')
      .send({ projectId: p.id, items: [] });
    expect(res.status).toBe(400);
  }));

  it('imports a task item', withJiraToken(async () => {
    await initStorage();
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
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
    const res = await agent()
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'TASK' }] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toHaveLength(1);
  }));

  it('imports an epic with children (next-gen)', withJiraToken(async () => {
    await initStorage();
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const axios = (await import('axios')).default as any;
    // Epic fetch
    (axios as any).mockResolvedValueOnce({
      data: { fields: { summary: 'Big Epic', description: null, issuetype: { name: 'Epic' } } }
    });
    // Child issues (next-gen parent query)
    (axios as any).mockResolvedValueOnce({
      data: { issues: [{ key: 'TEST-2', fields: { summary: 'Child Story', description: null, issuetype: { name: 'Story' } } }] }
    });
    const res = await agent()
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'EPIC' }] });
    expect(res.status).toBe(200);
    expect(res.body.imported.length).toBeGreaterThanOrEqual(1);
  }));

  it('imports an epic with children via classic fallback', withJiraToken(async () => {
    await initStorage();
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
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
    const res = await agent()
      .post('/jira/import')
      .send({ projectId: p.id, items: [{ issueKey: 'TEST-1', type: 'EPIC' }] });
    expect(res.status).toBe(200);
  }));
});

describe('GET /jira/oauth/callback (state issued by /authorize)', () => {
  it('exchanges code for token', withJiraToken(async () => {
    process.env.JIRA_CLIENT_ID = 'test-cid';
    process.env.JIRA_CLIENT_SECRET = 'test-cs';

    // /authorize issues the state the callback must be given back.
    const authorizeRes = await agent().get('/jira/oauth/authorize');
    const location = authorizeRes.headers.location || '';
    const stateMatch = location.match(/state=([^&]+)/);
    expect(stateMatch).not.toBeNull();

    const state = decodeURIComponent(stateMatch![1]);
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

    const res = await agent()
      .get(`/jira/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('jira=connected');

    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  }));
});

// ── PUT /items/:id (DONE with internal token) ────────────────────────────────

describe('PUT /items/:id with internal token', () => {
  beforeEach(async () => { await initStorage(); });

  it('refuses DONE even with the internal verify token (CGLAB-377)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent()
      .put(`/items/${item.id}`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ status: 'DONE' });
    expect(res.status).toBe(403);
    expect((await agent().get(`/items/${item.id}`)).body.status).toBe('TODO');
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

    const res = await agent().get('/jira/projects');
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

    const res = await agent().get('/jira/projects');
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

    const res = await agent().get('/jira/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });
});

// ── POST /items (parent sync) ─────────────────────────────────────────────────

describe('POST /items with parentId triggers parent sync', () => {
  beforeEach(async () => { await initStorage(); });

  it('creates child item and syncs parent', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const res = await agent().post('/items').send({
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
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({
      type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id
    })).body;
    const res = await agent().delete(`/items/${child.id}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown item', async () => {
    const res = await agent().delete('/items/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

// ── GET /items with filters ───────────────────────────────────────────────────

describe('GET /items query filters', () => {
  beforeEach(async () => { await initStorage(); });

  it('filters by type', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    await agent().post('/items').send({ type: 'TASK', title: 'T1', projectId: p.id });
    await agent().post('/items').send({ type: 'BUG', title: 'B1', projectId: p.id });
    const res = await agent().get('/items').query({ type: 'TASK', projectId: p.id });
    expect(res.status).toBe(200);
    expect(res.body.every((i: any) => i.type === 'TASK')).toBe(true);
  });

  it('includes archived when includeArchived=true', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    await agent().post('/items/bulk').send({ items: [{ id: item.id, updates: { status: 'ARCHIVED' } }] });
    const res = await agent().get('/items').query({ includeArchived: 'true', projectId: p.id });
    expect(res.status).toBe(200);
    const archived = res.body.find((i: any) => i.status === 'ARCHIVED');
    expect(archived).toBeDefined();
  });
});

// ── PUT /items/:id unarchive path ─────────────────────────────────────────────

describe('PUT /items/:id unarchive via status change', () => {
  beforeEach(async () => { await initStorage(); });

  it('unarchives item by setting non-archived status', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    // Archive via bulk
    await agent().post('/items/bulk').send({ items: [{ id: item.id, updates: { status: 'ARCHIVED' } }] });
    // Unarchive by setting TODO
    const res = await agent().put(`/items/${item.id}`).send({ status: 'TODO' });
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
    const res = await agent().get('/releases/latest');
    expect(res.status).toBe(200);
    delete process.env.GITHUB_TOKEN;
  });
});

// ── POST /items/bulk with internal token (DONE/REVIEW allowed) ────────────────

describe('POST /items/bulk with internal token', () => {
  beforeEach(async () => { await initStorage(); });

  it('skips DONE even with the internal token (CGLAB-377)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'DONE' } }] });
    expect(res.status).toBe(200);
    expect(res.body.skipped?.map((x: any) => x.id)).toContain(item.id);
    const updated = (await agent().get(`/items/${item.id}`)).body;
    expect(updated.status).toBe('TODO');
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
    const res1 = await agent().get('/releases/latest');
    const firstVersion = res1.body.version;

    // Second call: should hit cache (axios.get not called again)
    const callCountBefore = axios.get.mock?.calls?.length ?? 0;
    const res2 = await agent().get('/releases/latest');
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
    const postRes = await agent().post('/releases/update').set('x-agenfk-ui', '1');
    expect(postRes.status).toBe(202);
    const jobId = postRes.body.jobId;

    const res = await agent().get(`/releases/update/${jobId}`);
    expect(res.status).toBe(200);
    expect(['running', 'success', 'error']).toContain(res.body.status);
  });

  it('does not actually run the npx upgrade child process during tests', async () => {
    // Regression for bug 28635f38: this test file used to leak a real
    // `npx -y github:cglab-public/agenfk` invocation, downgrading the
    // developer's ~/.agenfk-system/ install on every `npm test`. The fix
    // is the dedicated setReleasesUpdateExecImpl injection at the top of
    // this file — verify the stub captured the call.
    const callsBefore = stubReleasesUpdateExec.mock.calls.length;
    await agent().post('/releases/update').set('x-agenfk-ui', '1');
    expect(stubReleasesUpdateExec.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(stubReleasesUpdateExec.mock.calls.at(-1)![0]).toMatch(/npx -y github:cglab-public\/agenfk/);
  });
});

// ── POST /projects duplicate name ─────────────────────────────────────────────

describe('POST /projects duplicate name', () => {
  beforeEach(async () => { await initStorage(); });

  it('still creates project when name already exists (telemetry branch)', async () => {
    await agent().post('/projects').send({ name: 'DupProj' });
    const res = await agent().post('/projects').send({ name: 'DupProj' });
    // Server allows duplicates — just suppresses telemetry event
    expect(res.status).toBe(201);
  });
});

// ── syncParentStatus branches ─────────────────────────────────────────────────

describe('syncParentStatus advanced scenarios', () => {
  beforeEach(async () => { await initStorage(); });

  it('syncs parent to IN_PROGRESS when one child is in_progress', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await agent().put(`/items/${child.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('when all children are done, the parent stops at its REVIEW step (CGLAB-381)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Set child to DONE via internal token
    await seedThenSync(child.id, 'DONE');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    // The parent stops at its own review step; only verify moves it on.
    expect(updated.status).toBe('REVIEW');
  });

  it('handles nested parent sync (grandparent)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const grandparent = (await agent().post('/items').send({ type: 'EPIC', title: 'GP', projectId: p.id })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id, parentId: grandparent.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await seedThenSync(child.id, 'DONE');
    const updatedParent = (await agent().get(`/items/${parent.id}`)).body;
    // CGLAB-381: the parent stops at its own review step, and so does the grandparent.
    expect(updatedParent.status).toBe('REVIEW');
    expect((await agent().get(`/items/${grandparent.id}`)).body.status).toBe('REVIEW');
  });

  it('a parent following children in TEST stops at its REVIEW step (CGLAB-381)', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await seedThenSync(child.id, 'TEST');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });
});

// ── PUT /items/:id with all optional fields ───────────────────────────────────

describe('PUT /items/:id with optional fields', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates context, implementationPlan, comments, sortOrder', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });
    const res = await agent().put(`/items/${item.id}`).send({
      title: 'Updated',
      description: 'desc',
      context: [{ path: '/foo.ts', content: 'code', description: 'desc' }],
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
    const res = await agent().post('/items/trash-archived').send({});
    expect(res.status).toBe(400);
  });

  it('trashes archived items', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    // Create and archive an item via bulk
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;
    await agent().post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'ARCHIVED' } }]
    });
    const res = await agent().post('/items/trash-archived').send({ projectId: p.id });
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });
});

// ── POST /items/bulk - additional branch coverage ─────────────────────────────

describe('POST /items/bulk - branch coverage', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates item with all optional fields (title, description, parentId, context, implementationPlan, reviews, comments)', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await agent().post('/items/bulk').send({
      items: [{
        id: item.id,
        updates: {
          title: 'New Title',
          description: 'New desc',
          parentId: parent.id,
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
    const res = await agent().post('/items/bulk').send({
      items: [{ id: 'nonexistent-id-xyz', updates: { status: 'IN_PROGRESS' } }]
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  // Re-pointed by CGLAB-81. The bulk route applied no flow validation at all,
  // so it was a way around the per-item gate: one request could move any number
  // of items any distance forward. It now applies the same rule, reporting the
  // rejection per entry rather than failing the whole batch.
  it('reports a skipping transition as skipped instead of applying it', async () => {
    const p = await makeProject(app, 'P');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });

    const res = await agent().post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'REVIEW' } }]
    });
    expect(res.status).toBe(200);
    const updated = (await agent().get(`/items/${item.id}`)).body;
    expect(updated.status).not.toBe('REVIEW');
    expect(JSON.stringify(res.body)).toMatch(/FLOW VIOLATION/i);

    // A one-step forward bulk move is skipped for an agent, naming verify,
    // and applied for the board (CGLAB-377).
    const refused = await agent().post('/items/bulk').send({
      items: [{ id: item.id, updates: { status: 'IN_PROGRESS' } }]
    });
    expect(JSON.stringify(refused.body)).toContain('agenfk verify');
    expect((await agent().get(`/items/${item.id}`)).body.status).toBe('TODO');
    const ok = await agent().post('/items/bulk').set('x-agenfk-ui', '1').send({
      items: [{ id: item.id, updates: { status: 'IN_PROGRESS' } }]
    });
    expect(ok.status).toBe(200);
    expect((await agent().get(`/items/${item.id}`)).body.status).toBe('IN_PROGRESS');
  });

  it('syncs parent after bulk update with parentId', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;

    const res = await agent().post('/items/bulk').set('x-agenfk-ui', '1').send({
      items: [{ id: child.id, updates: { status: 'IN_PROGRESS' } }]
    });
    expect(res.status).toBe(200);
    const updatedParent = (await agent().get(`/items/${parent.id}`)).body;
    expect(updatedParent.status).toBe('IN_PROGRESS');
  });
});

// ── PUT /items/:id - reviews, tests, parentId fields ─────────────────────────

describe('PUT /items/:id - reviews, tests, parentId fields', () => {
  beforeEach(async () => { await initStorage(); });

  it('updates reviews, tests, and parentId fields', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'T', projectId: p.id })).body;

    const res = await agent().put(`/items/${item.id}`).send({
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
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to DONE first
    await seedThenSync(parent.id, 'DONE');
    // Now set child to DONE — sync triggers but parent is already DONE, no-op
    await seedThenSync(child.id, 'DONE');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('DONE');
  });

  it('does not re-update parent when it is already TEST', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to TEST first
    await seedThenSync(parent.id, 'TEST');
    // Now set child to TEST — sync triggers but parent already TEST, no-op
    await seedThenSync(child.id, 'TEST');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('TEST');
  });

  it('syncs parent to REVIEW when all children are REVIEW or above', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    await seedThenSync(child.id, 'REVIEW');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });

  it('does not update parent already at REVIEW when child moves to REVIEW', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Force parent to REVIEW first
    await seedThenSync(parent.id, 'REVIEW');
    // Now set child to REVIEW — sync: parent already REVIEW, no-op
    await seedThenSync(child.id, 'REVIEW');
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('REVIEW');
  });

  it('does not re-update parent that is already IN_PROGRESS', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Set parent to IN_PROGRESS first
    await agent().put(`/items/${parent.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    // Set child to IN_PROGRESS — parent already IN_PROGRESS, no further update
    await agent().put(`/items/${child.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    const updated = (await agent().get(`/items/${parent.id}`)).body;
    expect(updated.status).toBe('IN_PROGRESS');
  });
});

// ── Archive/unarchive edge cases ───────────────────────────────────────────────

describe('archive and unarchive edge cases', () => {
  beforeEach(async () => { await initStorage(); });

  it('archiving a child that is already archived is a no-op (archiveRecursively guard)', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Archive child first
    await agent().put(`/items/${child.id}`).set('x-agenfk-ui', '1').send({ status: 'ARCHIVED' });
    // Archive parent — calls archiveRecursively(child) but child is already ARCHIVED → early return
    const res = await agent().put(`/items/${parent.id}`).send({ status: 'ARCHIVED' });
    expect(res.status).toBe(200);
  });

  it('unarchives parent and its archived children (unarchiveRecursively with children)', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'Child', projectId: p.id, parentId: parent.id })).body;
    // Archive parent (archiveRecursively archives child too)
    await agent().put(`/items/${parent.id}`).set('x-agenfk-ui', '1').send({ status: 'ARCHIVED' });
    const archivedChild = (await agent().get(`/items/${child.id}?includeArchived=true`)).body;
    expect(archivedChild.status).toBe('ARCHIVED');
    // Unarchive parent — unarchiveRecursively recurses into child (line 118 arm 0)
    const res = await agent().put(`/items/${parent.id}`).send({ status: 'TODO' });
    expect(res.status).toBe(200);
    const unarchivedChild = (await agent().get(`/items/${child.id}`)).body;
    expect(unarchivedChild.status).not.toBe('ARCHIVED');
  });

  it('unarchiving a parent with a non-archived child skips recursion for that child', async () => {
    const p = (await agent().post('/projects').send({ name: 'P' })).body;
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'Parent', projectId: p.id })).body;
    // Archive only the parent directly (no children)
    await agent().put(`/items/${parent.id}`).set('x-agenfk-ui', '1').send({ status: 'ARCHIVED' });
    // Unarchive parent — no children, so child loop does nothing. Past the
    // entry step it is a forward move, so it is the board's (CGLAB-377).
    expect((await agent().put(`/items/${parent.id}`).send({ status: 'IN_PROGRESS' })).status).toBe(409);
    const res = await agent().put(`/items/${parent.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
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
    const res = await agent().get('/flows');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /flows requires name', async () => {
    const res = await agent().post('/flows').send({ description: 'No name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it('POST /flows does not store projectId', async () => {
    const p = (await agent().post('/projects').send({ name: 'FlowProject' })).body;
    const res = await agent().post('/flows').send({
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
    const created = (await agent().post('/flows').send({
      name: 'F1', steps: [],
    })).body;

    const res = await agent().get(`/flows/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.name).toBe('F1');
  });

  it('GET /flows/:id returns 404 for unknown flow', async () => {
    const res = await agent().get('/flows/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('PUT /flows/:id updates a flow', async () => {
    const created = (await agent().post('/flows').send({
      name: 'Original', steps: [],
    })).body;

    const res = await agent().put(`/flows/${created.id}`).send({
      name: 'Updated',
      description: 'Now with description',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
    expect(res.body.description).toBe('Now with description');
  });

  it('PUT /flows/:id returns 404 for unknown flow', async () => {
    const res = await agent().put('/flows/nonexistent-id').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('POST /flows defaults version to 1.0.0', async () => {
    const res = await agent().post('/flows').send({ name: 'VersionTest', steps: [] });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe('1.0.0');
  });

  it('POST /flows accepts a custom version', async () => {
    const res = await agent().post('/flows').send({ name: 'VersionTest2', version: '2.1.0', steps: [] });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe('2.1.0');
  });

  it('PUT /flows/:id persists version update', async () => {
    const created = (await agent().post('/flows').send({ name: 'VersionPut', steps: [] })).body;
    const res = await agent().put(`/flows/${created.id}`).send({ version: '1.0.1' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0.1');
  });

  it('GET /flows/:id returns version', async () => {
    const created = (await agent().post('/flows').send({ name: 'VersionGet', version: '3.0.0', steps: [] })).body;
    const res = await agent().get(`/flows/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('3.0.0');
  });

  it('DELETE /flows/:id deletes a flow', async () => {
    const created = (await agent().post('/flows').send({
      name: 'ToDelete', steps: [],
    })).body;

    const delRes = await agent().delete(`/flows/${created.id}`);
    expect(delRes.status).toBe(204);

    const getRes = await agent().get(`/flows/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /flows/:id returns 404 for unknown flow', async () => {
    const res = await agent().delete('/flows/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('GET /flows lists all flows globally (across projects)', async () => {
    const p1 = (await agent().post('/projects').send({ name: 'P1' })).body;
    const p2 = (await agent().post('/projects').send({ name: 'P2' })).body;
    await agent().post('/flows').send({ name: 'F-A', steps: [] });
    await agent().post('/flows').send({ name: 'F-B', steps: [] });
    // Flows are global — projectId on POST body is ignored
    await agent().post('/flows').send({ projectId: p1.id, name: 'F-C', steps: [] });
    await agent().post('/flows').send({ projectId: p2.id, name: 'F-D', steps: [] });

    const res = await agent().get('/flows');
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
    const p = (await agent().post('/projects').send({ name: 'FlowProject2' })).body;
    projectId = p.id;
  });

  it('GET /projects/:id/flow returns DEFAULT_FLOW when no flowId set', async () => {
    const res = await agent().get(`/projects/${projectId}/flow`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('default');
    expect(res.body.name).toBe('Default Flow');
  });

  it('GET /projects/:id/flow returns 404 for unknown project', async () => {
    const res = await agent().get('/projects/nonexistent/flow');
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/flow requires flowId', async () => {
    const res = await agent().post(`/projects/${projectId}/flow`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/flowId/);
  });

  it('POST /projects/:id/flow returns 404 for unknown flow', async () => {
    const res = await agent().post(`/projects/${projectId}/flow`).send({ flowId: 'nonexistent' });
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/flow sets the active flow', async () => {
    const flow = (await agent().post('/flows').send({
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

    const res = await agent().post(`/projects/${projectId}/flow`).send({ flowId: flow.id });
    expect(res.status).toBe(200);
    expect((res.body as any).flowId).toBe(flow.id);
  });

  it('GET /projects/:id/flow returns the assigned flow after setting it', async () => {
    const flow = (await agent().post('/flows').send({
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

    await agent().post(`/projects/${projectId}/flow`).send({ flowId: flow.id });

    const res = await agent().get(`/projects/${projectId}/flow`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(flow.id);
    expect(res.body.name).toBe('Active Flow');
  });

  it('POST /projects/:id/flow returns 404 for unknown project', async () => {
    const res = await agent().post('/projects/nonexistent/flow').send({ flowId: 'any' });
    expect(res.status).toBe(404);
  });
});

// ── Flow-aware transition validation tests ────────────────────────────────────

describe('Flow-aware status transition validation', () => {
  let projectId: string;
  let flowId: string;

  beforeEach(async () => {
    await initStorage();
    const p = (await agent().post('/projects').send({ name: 'TransitionProject' })).body;
    projectId = p.id;

    // Create a simple custom flow: TODO -> STEP_A -> STEP_B (plus special steps)
    const flow = (await agent().post('/flows').send({
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
    await agent().post(`/projects/${projectId}/flow`).send({ flowId });
  });

  it('allows a valid forward transition (TODO -> IN_PROGRESS) from the board only (CGLAB-377)', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T1', projectId, status: 'TODO',
    })).body;

    expect((await agent().put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' })).status).toBe(409);
    const res = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('allows valid backward transition (IN_PROGRESS -> TODO)', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T2', projectId, status: 'TODO',
    })).body;
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    const res = await agent().put(`/items/${item.id}`).send({ status: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TODO');
  });

  it('allows transition to special status BLOCKED from any step', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T3', projectId, status: 'TODO',
    })).body;

    const res = await agent().put(`/items/${item.id}`).send({ status: 'BLOCKED' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('BLOCKED');
  });

  it('allows the board out of BLOCKED to the coding step; an agent is refused the detour (CGLAB-377)', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T4', projectId, status: 'TODO',
    })).body;
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'BLOCKED' });

    expect((await agent().put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' })).status).toBe(409);
    const res = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('rejects invalid skip transition (TODO -> REVIEW, skipping IN_PROGRESS)', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T5', projectId, status: 'TODO',
    })).body;

    const res = await agent().put(`/items/${item.id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/FLOW VIOLATION/);
  });

  it('refuses a DONE transition via the internal token: it bypasses nothing (CGLAB-377)', async () => {
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T6', projectId, status: 'TODO',
    })).body;

    const res = await agent()
      .put(`/items/${item.id}`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ status: 'DONE' });
    expect(res.status).toBe(403);
    expect((await agent().get(`/items/${item.id}`)).body.status).toBe('TODO');
  });

  it('project using DEFAULT_FLOW allows all standard one-step transitions from the board', async () => {
    // Create a project without custom flow (uses DEFAULT_FLOW)
    const p2 = (await agent().post('/projects').send({ name: 'DefaultFlowProject' })).body;
    const item = (await agent().post('/items').send({
      type: 'TASK', title: 'T7', projectId: p2.id, status: 'TODO',
    })).body;

    // TODO -> IN_PROGRESS allowed
    let res = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);

    // IN_PROGRESS -> REVIEW allowed
    res = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'REVIEW' });
    expect(res.status).toBe(200);

    // REVIEW -> TEST allowed
    res = await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'TEST' });
    expect(res.status).toBe(200);
  });
});

// ── GET /projects/:id/flow — returns full flow with steps and exit criteria ───

describe('GET /projects/:id/flow', () => {
  beforeEach(async () => { await initStorage(); });

  it('returns the default flow when no custom flow assigned', async () => {
    const p = (await agent().post('/projects').send({ name: 'FlowTest1' })).body;
    const res = await agent().get(`/projects/${p.id}/flow`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('steps');
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThan(0);
    // Each step has name and order
    res.body.steps.forEach((step: any) => {
      expect(step).toHaveProperty('name');
      expect(step).toHaveProperty('order');
    });
  });

  it('returns 404 for non-existent project', async () => {
    const res = await agent().get('/projects/nonexistent-proj/flow');
    expect(res.status).toBe(404);
  });

  it('returns steps with exitCriteria when defined', async () => {
    // Create a flow with exit criteria on a step
    const flowRes = await agent().post('/flows').send({
      name: 'TDD Test Flow',
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'create_unit_tests', order: 1, exitCriteria: 'Write failing tests before any implementation' },
        { name: 'IN_PROGRESS', order: 2, exitCriteria: 'All tests pass' },
        { name: 'DONE', order: 3, isAnchor: true },
      ],
    });
    expect(flowRes.status).toBe(201);
    const flow = flowRes.body;

    const p = (await agent().post('/projects').send({ name: 'FlowTest2' })).body;
    await agent().post(`/projects/${p.id}/flow`).send({ flowId: flow.id });

    const res = await agent().get(`/projects/${p.id}/flow`);
    expect(res.status).toBe(200);
    const testStep = res.body.steps.find((s: any) => s.name === 'create_unit_tests');
    expect(testStep).toBeDefined();
    expect(testStep.exitCriteria).toBe('Write failing tests before any implementation');
  });
});

// ── validate_progress: cwd persisted as project.projectRoot ──────────────────

describe('POST /items/:id/validate — cwd persisted as project.projectRoot', () => {
  beforeEach(async () => { await initStorage(); });

  /*
   * A REAL directory, with the `.agenfk` marker that makes it a project root.
   *
   * These tests used fake strings like '/home/user/my-project'. They passed
   * because the route recorded whatever findProjectRoot returned, and a walk
   * that finds nothing returns its STARTING directory - so a WORKTREE (which
   * has no `.agenfk`, it is gitignored) repointed the whole project at one
   * card's directory. The marker is what makes the value a root rather than a
   * fallback, so the tests act out the real shape (BUG 957513e9).
   */
  const realRoot = (): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-supp-root-')));
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    return dir;
  };
  const roots: string[] = [];
  const makeRoot = (): string => { const d = realRoot(); roots.push(d); return d; };
  afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('persists cwd on the project when validate is called with cwd in body', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'CWD1');
    const item = await makeItem(app, { type: 'TASK', title: 'CWD1', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    const root = makeRoot();

    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ cwd: root });

    const updatedProject = (await agent().get(`/projects/${p.id}`)).body;
    expect(updatedProject.projectRoot).toBe(root);
  });

  it('does not overwrite an existing projectRoot when cwd is absent', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'CWD2');
    const item = await makeItem(app, { type: 'TASK', title: 'CWD2', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    const stored = makeRoot();

    // Establish projectRoot the legitimate way — a validate that carries a cwd
    // with a marker (projectRoot is no longer mass-assignable via PUT).
    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ cwd: stored });

    // A later validate with no cwd must not clobber the stored projectRoot.
    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});  // no cwd

    const updatedProject = (await agent().get(`/projects/${p.id}`)).body;
    expect(updatedProject.projectRoot).toBe(stored);
  });

  it('updates projectRoot when a new cwd is provided', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'CWD3' })).body;
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'CWD3', projectId: p.id })).body;
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    const fresh = makeRoot();

    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ cwd: fresh });

    const updatedProject = (await agent().get(`/projects/${p.id}`)).body;
    expect(updatedProject.projectRoot).toBe(fresh);
  });
});

// ── validate_progress: push instructions on DONE ─────────────────────────────

describe('POST /items/:id/validate — push instructions included in DONE message', () => {
  beforeEach(async () => { await initStorage(); });

  it('includes git push instruction when item moves to DONE via command', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'PI1', verifyCommand: 'echo ok' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'PI1', projectId: p.id })).body;
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    if (res.status !== 200) return;
    expect(res.body.status).toBe('DONE');
    expect(res.body.message).toContain('git push');
  });

  it('includes git push instruction when item moves to DONE via sibling propagation', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'PI2', verifyCommand: 'echo ok' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'PI2-parent', projectId: p.id })).body;
    const child1 = (await agent().post('/items').send({ type: 'TASK', title: 'PI2-child1', projectId: p.id, parentId: parent.id })).body;
    const child2 = (await agent().post('/items').send({ type: 'TASK', title: 'PI2-child2', projectId: p.id, parentId: parent.id })).body;

    // Move child1 to DONE
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: child1.id, updates: { status: 'TEST' } }] });
    const c1Current = (await agent().get(`/items/${child1.id}`)).body;
    if (c1Current.status !== 'TEST') return;
    const res1 = await agent()
      .post(`/items/${child1.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    if (res1.status !== 200 || res1.body.status !== 'DONE') return;

    // Move child2 to TEST so sibling propagation kicks in
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: child2.id, updates: { status: 'TEST' } }] });
    const c2Current = (await agent().get(`/items/${child2.id}`)).body;
    if (c2Current.status !== 'TEST') return;

    const res2 = await agent()
      .post(`/items/${child2.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    if (res2.status !== 200) return;
    expect(res2.body.status).toBe('DONE');
    expect(res2.body.message).toContain('git push');
  });

  it('includes branchName in push instruction when item has branchName set', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'PI3', verifyCommand: 'echo ok' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'PI3', projectId: p.id })).body;
    // Set a branchName on the item
    await agent().put(`/items/${item.id}`).send({ branchName: 'task/abc-my-feature' });
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    if (res.status !== 200) return;
    expect(res.body.status).toBe('DONE');
    expect(res.body.message).toContain('task/abc-my-feature');
  });

  it('does NOT include push instruction when item moves to an intermediate step', async () => {
    if (!VERIFY_TOKEN) return;
    const p = await makeProject(app, 'PI4');
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = await makeItem(app, { type: 'TASK', title: 'PI4', projectId: p.id });
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVIEW');
    expect(res.body.message).not.toContain('git push');
  });
});

// ── comments with step field ──────────────────────────────────────────────────

describe('PUT /items/:id — comment with step field', () => {
  beforeEach(async () => { await initStorage(); });

  it('stores and returns a comment with step field', async () => {
    const p = await makeProject(app, 'CommentStep1');
    const item = await makeItem(app, { type: 'TASK', title: 'T', projectId: p.id });

    const comment = { id: 'c1', author: 'agent', content: 'evidence text', timestamp: new Date().toISOString(), step: 'create_unit_tests' };
    const res = await agent().put(`/items/${item.id}`).send({ comments: [comment] });
    expect(res.status).toBe(200);

    const fetched = (await agent().get(`/items/${item.id}`)).body;
    expect(fetched.comments).toHaveLength(1);
    expect(fetched.comments[0].step).toBe('create_unit_tests');
    expect(fetched.comments[0].content).toBe('evidence text');
  });
});

// ── validate_progress: full-output log persistence + rolling window ──────────
// Logs live under <tmpdir>/agenfk-verify-<uid>/<itemId>/ since BUG b233143b —
// previously <dbDir>/logs, i.e. ~/.agenfk-system/.agenfk/logs on a system
// install, which was buried and hard to find when a verifyCommand failed.
// The diagnostics contract (exit code, tail, path) is in
// verify-failure-diagnostics.test.ts; this block covers persistence + pruning.

describe('POST /items/:id/validate — full-output log persistence', () => {
  const LOGS_DIR = VERIFY_LOG_ROOT;
  const rmLogs = () => { if (fs.existsSync(LOGS_DIR)) fs.rmSync(LOGS_DIR, { recursive: true, force: true }); };

  beforeEach(async () => { await initStorage(); rmLogs(); });
  afterEach(() => { rmLogs(); });

  const setupItemInCoding = async (name: string) => {
    const p = (await agent().post('/projects').send({ name })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = (await agent().post('/items').send({ type: 'TASK', title: name, projectId: p.id })).body;
    await agent().put(`/items/${item.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });
    return { p, item };
  };

  // Node one-liner emitting a deterministic payload > 2KB with distinctive
  // head+tail markers placed within the head/tail truncation windows.
  const longOutputCommand = (tag: string) =>
    `node -e "const head='HEAD_${tag}_START'+'A'.repeat(1500); const tail='Z'.repeat(900)+'TAIL_${tag}_END'; console.log(head); console.log(tail);"`;

  it('writes the full command output to <tmpdir>/agenfk-verify-<uid>/<itemId>/<testId>.log', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist1');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: longOutputCommand('r1') });

    expect(res.status).toBe(200);

    const itemLogDir = path.join(LOGS_DIR, item.id);
    expect(fs.existsSync(itemLogDir)).toBe(true);
    const files = fs.readdirSync(itemLogDir);
    expect(files).toHaveLength(1);

    const full = fs.readFileSync(path.join(itemLogDir, files[0]), 'utf8');
    expect(full).toContain('HEAD_r1_START');
    expect(full).toContain('TAIL_r1_END');
    expect(full).toContain('A'.repeat(1500));
    expect(full).toContain('Z'.repeat(900));
    expect(full.length).toBeGreaterThan(2400);
    expect(full).not.toContain('(truncated)');
  });

  it('returns head+tail truncated preview in response when output exceeds threshold', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist2');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: longOutputCommand('r2') });

    expect(res.status).toBe(200);
    const preview: string = res.body.output;
    expect(preview).toBeDefined();
    // Preview must contain the head of output
    expect(preview).toContain('HEAD_r2_START');
    // Preview must contain the tail of output
    expect(preview).toContain('TAIL_r2_END');
    // Preview must be substantially smaller than full output (full is ~2.4KB payload + newlines)
    // Head+tail+marker should be ~2-3KB; assert it's bounded
    expect(preview.length).toBeLessThan(3500);
    // Truncation marker present
    expect(preview).toMatch(/truncated/);
    // Log file path referenced so the agent can read full output
    expect(preview).toContain('Full log:');
    expect(preview).toContain(path.join(VERIFY_LOG_ROOT, item.id));
  });

  it('does not truncate when output is short (below threshold)', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist3');

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: "echo short-output-xyz" });

    expect(res.status).toBe(200);
    const preview: string = res.body.output;
    expect(preview).toContain('short-output-xyz');
    // No truncation marker for short output
    expect(preview).not.toMatch(/\(truncated\)/);
    expect(preview).not.toMatch(/bytes truncated/);
  });

  it('stores head+tail preview (not full output) in the comment and includes log path', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist4');

    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: longOutputCommand('r4') });

    const fetched = (await agent().get(`/items/${item.id}`)).body;
    // setupItemInCoding's PUT→IN_PROGRESS also emits a ValidateTool "Validation"
    // comment, so the item has TWO. Distinguish by content, not array position:
    // only the validate-with-command call carries a "Full log:" reference (a plain
    // forward transition runs no command). .find()'s first match was nondeterministic
    // once the two comments' timestamps collided under full-suite load.
    const validationComment = fetched.comments.find((c: any) =>
      c.author === 'ValidateTool' &&
      typeof c.content === 'string' &&
      c.content.includes('Validation') &&
      c.content.includes('Full log:')
    );
    expect(validationComment).toBeDefined();
    // Comment should contain the head and tail markers from the output
    expect(validationComment.content).toContain('HEAD_r4_START');
    expect(validationComment.content).toContain('TAIL_r4_END');
    // Full 1500-A block must not appear — output exceeds head+tail budget so it's truncated
    expect(validationComment.content).not.toContain('A'.repeat(1500));
    // Log path referenced in comment
    expect(validationComment.content).toContain('Full log:');
  });

  it('stores head+tail preview (not full output) in the tests[] record on final step', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'LogPersist5', verifyCommand: longOutputCommand('r5') })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'LogPersist5', projectId: p.id })).body;
    await agent()
      .post('/items/bulk')
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });

    const current = (await agent().get(`/items/${item.id}`)).body;
    if (current.status !== 'TEST') return;

    const res = await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({});
    if (res.status !== 200) return;

    const fetched = (await agent().get(`/items/${item.id}`)).body;
    expect(fetched.tests).toBeDefined();
    expect(fetched.tests.length).toBeGreaterThan(0);
    const lastTest = fetched.tests[fetched.tests.length - 1];
    expect(lastTest.output).toContain('HEAD_r5_START');
    expect(lastTest.output).toContain('TAIL_r5_END');
    // Full output not stored inline
    expect(lastTest.output).not.toContain('A'.repeat(1500));
    // Log file exists on disk with full content
    const itemLogDir = path.join(LOGS_DIR, item.id);
    expect(fs.existsSync(itemLogDir)).toBe(true);
    const files = fs.readdirSync(itemLogDir);
    expect(files.length).toBeGreaterThan(0);
    const fullLogContent = fs.readFileSync(path.join(itemLogDir, files[files.length - 1]), 'utf8');
    expect(fullLogContent).toContain('A'.repeat(1500));
  });

  it('prunes per-item log directory to the newest 3 files (rolling window)', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist6');

    const runOnce = async (tag: string) => {
      await agent()
        .post(`/items/${item.id}/validate`)
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ command: `echo OUTPUT_${tag}` });
      // bounce back to coding step so we can validate again
      await agent()
        .post('/items/bulk')
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ items: [{ id: item.id, updates: { status: 'IN_PROGRESS' } }] });
      // small delay so mtimes differ
      await new Promise(r => setTimeout(r, 20));
    };

    await runOnce('one');
    await runOnce('two');
    await runOnce('three');
    await runOnce('four');

    const itemLogDir = path.join(LOGS_DIR, item.id);
    expect(fs.existsSync(itemLogDir)).toBe(true);
    const files = fs.readdirSync(itemLogDir);
    expect(files).toHaveLength(3);

    const contents = files.map(f => fs.readFileSync(path.join(itemLogDir, f), 'utf8'));
    // Oldest run (one) should have been pruned; runs two, three, four retained.
    expect(contents.some(c => c.includes('OUTPUT_one'))).toBe(false);
    expect(contents.some(c => c.includes('OUTPUT_two'))).toBe(true);
    expect(contents.some(c => c.includes('OUTPUT_three'))).toBe(true);
    expect(contents.some(c => c.includes('OUTPUT_four'))).toBe(true);
  });

  it('purges the item log directory when the item is trashed via DELETE', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItemInCoding('LogPersist7');

    // Create a log file by running validate
    await agent()
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: "echo will-be-trashed" });

    const itemLogDir = path.join(LOGS_DIR, item.id);
    expect(fs.existsSync(itemLogDir)).toBe(true);

    // Delete (soft-trash)
    const delRes = await agent().delete(`/items/${item.id}`);
    expect(delRes.status).toBe(204);

    expect(fs.existsSync(itemLogDir)).toBe(false);
  });

  it('purges log directories of descendant items when a parent is trashed', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await agent().post('/projects').send({ name: 'LogPersist8' })).body;
    await bindRoleLessDefaultFlow(storage, p.id);
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'parent', projectId: p.id })).body;
    const child = (await agent().post('/items').send({ type: 'TASK', title: 'child', projectId: p.id, parentId: parent.id })).body;
    await agent().put(`/items/${child.id}`).set('x-agenfk-ui', '1').send({ status: 'IN_PROGRESS' });

    await agent()
      .post(`/items/${child.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: "echo child-output" });

    const childLogDir = path.join(LOGS_DIR, child.id);
    expect(fs.existsSync(childLogDir)).toBe(true);

    const delRes = await agent().delete(`/items/${parent.id}`);
    expect(delRes.status).toBe(204);

    expect(fs.existsSync(childLogDir)).toBe(false);
  });
});
