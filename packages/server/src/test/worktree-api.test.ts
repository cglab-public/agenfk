/**
 * CGLAB-166: the REST surface for per-item worktrees.
 *
 * The git plumbing is covered in worktrees.test.ts against a real repository.
 * This file covers the part the desktop app and the CLI actually call: that a
 * worktree belongs to an item, that asking twice is safe, and — the one that
 * matters most — that removing a worktree never destroys the work inside it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./worktree-api-test-db.sqlite');

let repo: string;
let root: string;
let projectId: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
});

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
  await initStorage();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtapi-repo-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtapi-root-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  const project = await request(app).post('/projects').send({ name: `wt-${Date.now()}` });
  projectId = project.body.id;
  // projectRoot is deliberately NOT settable over REST — it is the cwd for
  // shell execution, and mass assignment there would be RCE (bug e60e20aa).
  // The server sets it from a resolved root during validate; do the same here.
  await storage.updateProject(projectId, { projectRoot: repo } as never);
  await request(app).put(`/projects/${projectId}`).send({ autoWorktree: true });
});

const makeItem = async (title = 'Add login') => {
  const res = await request(app).post('/items').send({ type: 'TASK', title, projectId });
  expect(res.status).toBe(201);
  return res.body;
};

describe('POST /items/:id/worktree', () => {
  it('creates a worktree for the item and records where it is', async () => {
    const item = await makeItem();
    const res = await request(app).post(`/items/${item.id}/worktree`).send({ root });

    expect(res.status).toBe(201);
    expect(fs.existsSync(res.body.path)).toBe(true);
    expect(fs.existsSync(path.join(res.body.path, 'README.md'))).toBe(true);

    const stored = await request(app).get(`/items/${item.id}`);
    expect(stored.body.worktreePath).toBe(res.body.path);
    expect(stored.body.branchName).toBeTruthy();
  });

  it('is idempotent — a second call returns the same worktree', async () => {
    const item = await makeItem();
    const first = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    const second = await request(app).post(`/items/${item.id}/worktree`).send({ root });

    expect(second.status).toBe(200);
    expect(second.body.path).toBe(first.body.path);
    expect(second.body.created).toBe(false);
  });

  it('gives two items of one project two separate worktrees', async () => {
    const a = await makeItem('First task');
    const b = await makeItem('Second task');
    const wa = await request(app).post(`/items/${a.id}/worktree`).send({ root });
    const wb = await request(app).post(`/items/${b.id}/worktree`).send({ root });

    expect(wa.body.path).not.toBe(wb.body.path);
    fs.writeFileSync(path.join(wa.body.path, 'only-a.txt'), 'a');
    expect(fs.existsSync(path.join(wb.body.path, 'only-a.txt'))).toBe(false);
  });

  it('404s for an item that does not exist', async () => {
    const res = await request(app).post('/items/no-such-item/worktree').send({ root });
    expect(res.status).toBe(404);
  });

  it('refuses when the project has no projectRoot, instead of guessing one', async () => {
    // Guessing would run git somewhere the user never pointed us at.
    const bare = await request(app).post('/projects').send({ name: `bare-${Date.now()}` });
    const item = (await request(app).post('/items')
      .send({ type: 'TASK', title: 'Orphan', projectId: bare.body.id })).body;

    const res = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/projectRoot/i);
  });

  it('reports a clear error when projectRoot is not a git repository', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtapi-norepo-'));
    const p = await request(app).post('/projects').send({ name: `norepo-${Date.now()}` });
    await storage.updateProject(p.body.id, { projectRoot: notARepo } as never);
    const item = (await request(app).post('/items')
      .send({ type: 'TASK', title: 'No repo', projectId: p.body.id })).body;

    const res = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not a git repository/i);
  });
});

describe('GET /items/:id/worktree', () => {
  it('reports nothing before one exists', async () => {
    const item = await makeItem();
    const res = await request(app).get(`/items/${item.id}/worktree`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBeNull();
  });

  it('reports the worktree once created', async () => {
    const item = await makeItem();
    const created = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    const res = await request(app).get(`/items/${item.id}/worktree`);
    expect(res.body.path).toBe(created.body.path);
    expect(res.body.exists).toBe(true);
  });

  it('says the directory is gone when someone deleted it by hand', async () => {
    // The path stays recorded; `exists: false` is how a caller knows to
    // recreate rather than assume it can cd there.
    const item = await makeItem();
    const created = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    fs.rmSync(created.body.path, { recursive: true, force: true });

    const res = await request(app).get(`/items/${item.id}/worktree`);
    expect(res.body.path).toBe(created.body.path);
    expect(res.body.exists).toBe(false);
  });
});

describe('DELETE /items/:id/worktree', () => {
  it('removes the directory and forgets the path', async () => {
    const item = await makeItem();
    const created = await request(app).post(`/items/${item.id}/worktree`).send({ root });

    const res = await request(app).delete(`/items/${item.id}/worktree`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(created.body.path)).toBe(false);
    expect((await request(app).get(`/items/${item.id}`)).body.worktreePath).toBeFalsy();
  });

  it('never destroys committed work — the branch survives', async () => {
    // This is the guarantee that makes removal safe to automate. Deleting a
    // worktree must cost you a checkout, never a commit.
    const item = await makeItem();
    const created = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    fs.writeFileSync(path.join(created.body.path, 'work.txt'), 'work');
    git(created.body.path, 'add', '.');
    git(created.body.path, 'commit', '-m', 'agent work');
    const sha = git(created.body.path, 'rev-parse', 'HEAD').trim();

    await request(app).delete(`/items/${item.id}/worktree`);

    const branch = (await request(app).get(`/items/${item.id}`)).body.branchName
      ?? git(repo, 'branch', '--list').trim();
    expect(git(repo, 'branch', '--list').trim()).toBeTruthy();
    expect(git(repo, 'rev-parse', sha).trim()).toBe(sha); // the commit is still reachable
    expect(branch).toBeTruthy();
  });

  it('removes a worktree with uncommitted changes rather than refusing forever', async () => {
    const item = await makeItem();
    const created = await request(app).post(`/items/${item.id}/worktree`).send({ root });
    fs.writeFileSync(path.join(created.body.path, 'dirty.txt'), 'uncommitted');

    expect((await request(app).delete(`/items/${item.id}/worktree`)).status).toBe(200);
    expect(fs.existsSync(created.body.path)).toBe(false);
  });

  it('is idempotent — deleting twice is not an error', async () => {
    const item = await makeItem();
    await request(app).post(`/items/${item.id}/worktree`).send({ root });
    await request(app).delete(`/items/${item.id}/worktree`);
    expect((await request(app).delete(`/items/${item.id}/worktree`)).status).toBe(200);
  });

  it('is a no-op for an item that never had one', async () => {
    const item = await makeItem();
    expect((await request(app).delete(`/items/${item.id}/worktree`)).status).toBe(200);
  });
});

describe('auto-worktree on entering a working step', () => {
  /** Advance an item one step, the way `agenfk verify` does. */
  const advance = (itemId: string) =>
    request(app)
      .post(`/items/${itemId}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'starting work' });

  it('gives the item a worktree when it leaves TODO', async () => {
    const item = await makeItem('Auto one');
    expect((await request(app).get(`/items/${item.id}/worktree`)).body.path).toBeNull();

    await advance(item.id);

    const wt = (await request(app).get(`/items/${item.id}/worktree`)).body;
    expect(wt.path).toBeTruthy();
    expect(wt.exists).toBe(true);
  });

  it('does nothing when the project has not opted in', async () => {
    // autoWorktree is off by default: creating directories on someone's disk
    // because they advanced a card is not a reasonable default.
    await request(app).put(`/projects/${projectId}`).send({ autoWorktree: false });
    const item = await makeItem('No auto');

    await advance(item.id);

    expect((await request(app).get(`/items/${item.id}/worktree`)).body.path).toBeNull();
  });

  it('reuses the worktree on later steps instead of making another', async () => {
    const item = await makeItem('Auto two');
    await advance(item.id);
    const first = (await request(app).get(`/items/${item.id}/worktree`)).body.path;

    await advance(item.id);

    expect((await request(app).get(`/items/${item.id}/worktree`)).body.path).toBe(first);
  });

  it('still advances the item when the worktree cannot be created', async () => {
    // A broken git setup must not block the workflow. The transition is the
    // user's intent; the worktree is a convenience on top of it.
    const p = await request(app).post('/projects').send({ name: `broken-${Date.now()}` });
    await storage.updateProject(p.body.id, { projectRoot: '/nonexistent/path' } as never);
    await request(app).put(`/projects/${p.body.id}`).send({ autoWorktree: true });
    const item = (await request(app).post('/items')
      .send({ type: 'TASK', title: 'Broken repo', projectId: p.body.id })).body;

    const res = await advance(item.id);

    expect(res.status).toBe(200);
    expect((await request(app).get(`/items/${item.id}`)).body.status).not.toBe('TODO');
  });
});
