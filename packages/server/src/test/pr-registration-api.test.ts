import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
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
    });
    const second = await request(app).post('/prs').send({
      itemId: item.id, prNumber: 200, repo: 'foo/bar',
      sizing: { epic: 0, story: 1, task: 5, bug: 0 },
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
    });

    const res = await request(app).put('/prs/foo%2Fbar/300').send({
      sizing: { epic: 0, story: 1, task: 4, bug: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.sizing).toEqual({ epic: 0, story: 1, task: 4, bug: 1 });
    expect(res.body.lastSizingCheckAt).toBeDefined();
  });

  it('PUT /prs/:repo/:number returns 404 when PR not registered', async () => {
    const res = await request(app).put('/prs/foo%2Fbar/999').send({
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
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
    });
    expect(res.status).toBe(201);
    expect(res.body.sizing).toEqual({ epic: 1, story: 1, task: 99, bug: 99 }); // agent's number persists
    expect(res.body.sizingShadow).toEqual({ epic: 1, story: 1, task: 2, bug: 1 }); // server's truth
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
    });
    expect(res.status).toBe(201);

    // @ts-ignore — access the raw SQLite db for assertion
    const { SqliteStorage } = await import('@agenfk/storage-sqlite');
    const db: import('better-sqlite3').Database = (await import('../server')).storage['database'];
    const rows = db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[];
    const payloads = rows.map(r => JSON.parse(r.payload));
    const prEvent = payloads.find((p: any) => p.type === 'pr.opened');
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
    });

    const res = await request(app).put('/prs/org%2Frepo2/502').send({
      sizing: { epic: 0, story: 0, task: 3, bug: 0 },
    });
    expect(res.status).toBe(200);

    const db: import('better-sqlite3').Database = (await import('../server')).storage['database'];
    const rows = db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[];
    const payloads = rows.map(r => JSON.parse(r.payload));
    const updEvent = payloads.find((p: any) => p.type === 'pr.updated' && p.payload?.prNumber === 502);
    expect(updEvent).toBeDefined();
    expect(updEvent.payload?.sizing?.task).toBe(3);
  });
});
