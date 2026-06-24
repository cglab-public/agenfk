import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

// The hub outbox only receives events when the hub is configured (HubClient.isEnabled).
// That config is read once, when ../server is first imported — so enable it here, before
// the import is evaluated, otherwise these assertions only pass on a machine that happens
// to have a real ~/.agenfk/hub.json (green locally, red in CI). Hoisted so it runs first.
vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});

import { app, initStorage } from '../server';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.put = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const ROOT = path.resolve(__dirname, '../../../..');
const TEST_DB = path.resolve('./pr-registration-test-db.sqlite');

// recordHubEvent enqueues into hub_outbox asynchronously: the POST/PUT handler
// fires it without awaiting, and it awaits a flow-name + git-remote lookup before
// inserting — so the row lands a tick or two after the HTTP response resolves.
// Reading the table once (as the original tests did) races under CI load; poll instead.
async function waitForOutboxPayload(
  predicate: (p: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const db: import('better-sqlite3').Database = (await import('../server')).storage['database'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[];
    const found = rows.map(r => JSON.parse(r.payload)).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('register_pr / update_pr_sizing — static registration', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(path.join(ROOT, 'packages/server/src/index.ts'), 'utf8');
  });
  for (const name of ['register_pr', 'update_pr_sizing']) {
    it(`declares "${name}" in tools list`, () => {
      expect(src).toMatch(new RegExp(`name:\\s*["']${name}["']`));
    });
    it(`handles "${name}" in case switch`, () => {
      expect(src).toMatch(new RegExp(`case\\s+["']${name}["']`));
    });
  }
});

describe('CLI: pr-register / pr-resize', () => {
  let cli: string;
  beforeAll(() => { cli = fs.readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8'); });
  it('declares pr-register command', () => {
    expect(cli).toMatch(/\.command\s*\(\s*['"]pr-register/);
  });
  it('declares pr-resize command', () => {
    expect(cli).toMatch(/\.command\s*\(\s*['"]pr-resize/);
  });
});

describe('REST: POST /prs and PUT /prs/:repo/:number', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  beforeEach(async () => { await initStorage(); });

  it('POST /prs registers a new PR with declared sizing', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;

    const res = await request(app).post('/prs').send({
      itemId: item.id,
      prNumber: 100,
      repo: 'foo/bar',
      sizing: { epic: 0, story: 1, task: 2, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      prNumber: 100,
      repo: 'foo/bar',
      itemId: item.id,
      sizing: { epic: 0, story: 1, task: 2, bug: 0 },
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.openedAt).toBeDefined();
  });

  it('POST /prs is idempotent on (repo, prNumber) — re-call refreshes sizing', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;

    await request(app).post('/prs').send({
      itemId: item.id, prNumber: 200, repo: 'foo/bar',
      sizing: { epic: 0, story: 1, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    const second = await request(app).post('/prs').send({
      itemId: item.id, prNumber: 200, repo: 'foo/bar',
      sizing: { epic: 0, story: 1, task: 5, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(second.status).toBe(201);
    expect(second.body.sizing).toEqual({ epic: 0, story: 1, task: 5, bug: 0 });
  });

  it('PUT /prs/:repo/:number updates sizing', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    await request(app).post('/prs').send({
      itemId: item.id, prNumber: 300, repo: 'foo/bar',
      sizing: { epic: 0, story: 1, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });

    const res = await request(app).put('/prs/foo%2Fbar/300').send({
      sizing: { epic: 0, story: 1, task: 4, bug: 1 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(200);
    expect(res.body.sizing).toEqual({ epic: 0, story: 1, task: 4, bug: 1 });
    expect(res.body.lastSizingCheckAt).toBeDefined();
  });

  it('PUT /prs/:repo/:number returns 404 when PR not registered', async () => {
    const res = await request(app).put('/prs/foo%2Fbar/999').send({
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(404);
  });

  it('POST /prs validates required fields', async () => {
    const res = await request(app).post('/prs').send({ prNumber: 1 });
    expect(res.status).toBe(400);
  });

  it('POST /prs computes shadow sizing from the item tree', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P' })).body;
    const epic = (await request(app).post('/items').send({ projectId: project.id, type: 'EPIC', title: 'E' })).body;
    const story = (await request(app).post('/items').send({ projectId: project.id, type: 'STORY', title: 'S', parentId: epic.id })).body;
    await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T1', parentId: story.id });
    await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T2', parentId: story.id });
    await request(app).post('/items').send({ projectId: project.id, type: 'BUG', title: 'B', parentId: story.id, severity: 'LOW' });

    const res = await request(app).post('/prs').send({
      itemId: epic.id, prNumber: 400, repo: 'foo/bar',
      sizing: { epic: 1, story: 1, task: 99, bug: 99 }, // deliberately wrong
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(201);
    expect(res.body.sizing).toEqual({ epic: 1, story: 1, task: 99, bug: 99 }); // agent's number persists
    expect(res.body.sizingShadow).toEqual({ epic: 1, story: 1, task: 2, bug: 1 }); // server's truth
  });
});

describe('agent-declared model + harness on PR events', () => {
  // Static: CLI flags — must be REQUIRED on both commands.
  it('CLI pr-register and pr-resize REQUIRE --model and --harness', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
    expect((cli.match(/\.requiredOption\(\s*['"]--model <id>/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((cli.match(/\.requiredOption\(\s*['"]--harness <name>/g) || []).length).toBeGreaterThanOrEqual(2);
    // ...and must NOT be declared as plain (optional) .option()
    expect(cli).not.toMatch(/\.option\(\s*['"]--model <id>/);
    expect(cli).not.toMatch(/\.option\(\s*['"]--harness <name>/);
  });

  // `agenfk pr create` must ALSO require --model/--harness (it auto-registers the
  // PR, so the pr.opened event carries the runtime). Three commands now require
  // them: pr-register, pr-resize, pr create.
  it('CLI "pr create" REQUIRES --model and --harness', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
    expect((cli.match(/\.requiredOption\(\s*['"]--model <id>/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((cli.match(/\.requiredOption\(\s*['"]--harness <name>/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  // Static: MCP tool schemas — model/harness must be REQUIRED (non-optional).
  it('register_pr and update_pr_sizing MCP schemas REQUIRE model + harness', () => {
    const src = fs.readFileSync(path.join(ROOT, 'packages/server/src/index.ts'), 'utf8');
    // Zod fields must be required (not .optional()).
    expect(src).toMatch(/model:\s*z\.string\(\),/);
    expect(src).toMatch(/harness:\s*z\.string\(\),/);
    expect(src).not.toMatch(/model:\s*z\.string\(\)\.optional\(\)/);
    expect(src).not.toMatch(/harness:\s*z\.string\(\)\.optional\(\)/);
    // Both advertised inputSchema required[] arrays must list model & harness.
    expect((src.match(/required:\s*\[[^\]]*"model"[^\]]*"harness"[^\]]*\]/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  // Behavioral: the fields ride into the hub event payloads
  it('POST /prs includes model + harness in the pr.opened payload', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PMH' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;

    const res = await request(app).post('/prs').send({
      itemId: item.id, prNumber: 601, repo: 'org/mh',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(201);

    const ev = await waitForOutboxPayload((p: any) => p.type === 'pr.opened' && p.payload?.prNumber === 601);
    expect(ev).toBeDefined();
    expect(ev.payload?.model).toBe('claude-opus-4-8');
    expect(ev.payload?.harness).toBe('claude-code');
  });

  it('PUT /prs includes model + harness in the pr.updated payload', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PMH2' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    await request(app).post('/prs').send({
      itemId: item.id, prNumber: 602, repo: 'org/mh2',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });

    const res = await request(app).put('/prs/org%2Fmh2/602').send({
      sizing: { epic: 0, story: 0, task: 2, bug: 0 },
      model: 'glm-5.2', harness: 'pi',
    });
    expect(res.status).toBe(200);

    const ev = await waitForOutboxPayload((p: any) => p.type === 'pr.updated' && p.payload?.prNumber === 602);
    expect(ev).toBeDefined();
    expect(ev.payload?.model).toBe('glm-5.2');
    expect(ev.payload?.harness).toBe('pi');
  });

  it('POST /prs rejects (400) when model or harness is omitted', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PMH3' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    const base = { itemId: item.id, prNumber: 603, repo: 'org/mh3', sizing: { epic: 0, story: 0, task: 1, bug: 0 } };

    expect((await request(app).post('/prs').send(base)).status).toBe(400); // both missing
    expect((await request(app).post('/prs').send({ ...base, model: 'glm-5.2' })).status).toBe(400); // harness missing
    expect((await request(app).post('/prs').send({ ...base, harness: 'pi' })).status).toBe(400); // model missing
  });

  it('PUT /prs rejects (400) when model or harness is omitted', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PMH4' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    await request(app).post('/prs').send({
      itemId: item.id, prNumber: 604, repo: 'org/mh4',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 }, model: 'glm-5.2', harness: 'pi',
    });
    const res = await request(app).put('/prs/org%2Fmh4/604').send({ sizing: { epic: 0, story: 0, task: 2, bug: 0 } });
    expect(res.status).toBe(400);
  });

  // Auto-registration path (used by `agenfk pr create`): sizing is OMITTED and the
  // server derives it from the item tree (shadow), so a single CLI call both opens
  // and registers the PR. model/harness stay required.
  it('POST /prs derives sizing from the item tree when sizing is omitted', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PAUTO' })).body;
    const epic = (await request(app).post('/items').send({ projectId: project.id, type: 'EPIC', title: 'E' })).body;
    const story = (await request(app).post('/items').send({ projectId: project.id, type: 'STORY', title: 'S', parentId: epic.id })).body;
    await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T1', parentId: story.id });
    await request(app).post('/items').send({ projectId: project.id, type: 'BUG', title: 'B', parentId: story.id, severity: 'LOW' });

    const res = await request(app).post('/prs').send({
      itemId: epic.id, prNumber: 700, repo: 'org/auto',
      model: 'glm-5.2', harness: 'pi', // no sizing
    });
    expect(res.status).toBe(201);
    // Declared sizing equals the shadow (derived from the tree).
    expect(res.body.sizing).toEqual({ epic: 1, story: 1, task: 1, bug: 1 });
    expect(res.body.sizingShadow).toEqual({ epic: 1, story: 1, task: 1, bug: 1 });

    const ev = await waitForOutboxPayload((p: any) => p.type === 'pr.opened' && p.payload?.prNumber === 700);
    expect(ev).toBeDefined();
    expect(ev.payload?.sizing).toEqual({ epic: 1, story: 1, task: 1, bug: 1 });
    expect(ev.payload?.model).toBe('glm-5.2');
    expect(ev.payload?.harness).toBe('pi');
  });

  it('POST /prs still rejects (400) when model/harness omitted even on the derive path', async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    const project = (await request(app).post('/projects').send({ name: 'PAUTO2' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    // sizing omitted AND model/harness omitted → still 400
    const res = await request(app).post('/prs').send({ itemId: item.id, prNumber: 701, repo: 'org/auto2' });
    expect(res.status).toBe(400);
  });
});

describe('POST /prs emits a hub event into the outbox', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('inserts a pr.opened event into hub_outbox on POST /prs', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;

    const res = await request(app).post('/prs').send({
      itemId: item.id, prNumber: 501, repo: 'org/repo',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(201);

    const prEvent = await waitForOutboxPayload((p: any) => p.type === 'pr.opened');
    expect(prEvent).toBeDefined();
    expect(prEvent.payload?.prNumber).toBe(501);
    expect(prEvent.payload?.repo).toBe('org/repo');
  });

  it('inserts a pr.updated event into hub_outbox on PUT /prs/:repo/:number', async () => {
    const project = (await request(app).post('/projects').send({ name: 'P2' })).body;
    const item = (await request(app).post('/items').send({ projectId: project.id, type: 'TASK', title: 'T' })).body;
    await request(app).post('/prs').send({
      itemId: item.id, prNumber: 502, repo: 'org/repo2',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });

    const res = await request(app).put('/prs/org%2Frepo2/502').send({
      sizing: { epic: 0, story: 0, task: 3, bug: 0 },
      model: 'claude-opus-4-8', harness: 'claude-code',
    });
    expect(res.status).toBe(200);

    const updEvent = await waitForOutboxPayload(
      (p: any) => p.type === 'pr.updated' && p.payload?.prNumber === 502,
    );
    expect(updEvent).toBeDefined();
    expect(updEvent.payload?.sizing?.task).toBe(3);
  });
});
