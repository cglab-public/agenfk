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
import { app, initStorage, storage, VERIFY_TOKEN, defaultWorktreeRoot, findProjectRoot } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 46 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


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
  // Sweep the roots this file created inside the real worktree base.
  try {
    for (const entry of fs.readdirSync(defaultWorktreeRoot())) {
      if (entry.startsWith('test-')) {
        fs.rmSync(path.join(defaultWorktreeRoot(), entry), { recursive: true, force: true });
      }
    }
  } catch { /* nothing to sweep */ }
});

beforeEach(async () => {
  await initStorage();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtapi-repo-'));
  // Inside the allowed base: the endpoint confines `root` on purpose, and a
  // test that needed an exception would be testing a weaker rule than ships.
  fs.mkdirSync(defaultWorktreeRoot(), { recursive: true });
  root = fs.mkdtempSync(path.join(defaultWorktreeRoot(), 'test-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  const project = await agent().post('/projects').send({ name: `wt-${Date.now()}` });
  projectId = project.body.id;
  // projectRoot is deliberately NOT settable over REST — it is the cwd for
  // shell execution, and mass assignment there would be RCE (bug e60e20aa).
  // The server sets it from a resolved root during validate; do the same here.
  await storage.updateProject(projectId, { projectRoot: repo } as never);
  await agent().put(`/projects/${projectId}`).send({ autoWorktree: true });
});

const makeItem = async (title = 'Add login') => {
  const res = await agent().post('/items').send({ type: 'TASK', title, projectId });
  expect(res.status).toBe(201);
  return res.body;
};

describe('POST /items/:id/worktree', () => {
  it('creates a worktree for the item and records where it is', async () => {
    const item = await makeItem();
    const res = await agent().post(`/items/${item.id}/worktree`).send({ root });

    expect(res.status).toBe(201);
    expect(fs.existsSync(res.body.path)).toBe(true);
    expect(fs.existsSync(path.join(res.body.path, 'README.md'))).toBe(true);

    const stored = await agent().get(`/items/${item.id}`);
    expect(stored.body.worktreePath).toBe(res.body.path);
    expect(stored.body.branchName).toBeTruthy();
  });

  it('is idempotent — a second call returns the same worktree', async () => {
    const item = await makeItem();
    const first = await agent().post(`/items/${item.id}/worktree`).send({ root });
    const second = await agent().post(`/items/${item.id}/worktree`).send({ root });

    expect(second.status).toBe(200);
    expect(second.body.path).toBe(first.body.path);
    expect(second.body.created).toBe(false);
  });

  it('gives two items of one project two separate worktrees', async () => {
    const a = await makeItem('First task');
    const b = await makeItem('Second task');
    const wa = await agent().post(`/items/${a.id}/worktree`).send({ root });
    const wb = await agent().post(`/items/${b.id}/worktree`).send({ root });

    expect(wa.body.path).not.toBe(wb.body.path);
    fs.writeFileSync(path.join(wa.body.path, 'only-a.txt'), 'a');
    expect(fs.existsSync(path.join(wb.body.path, 'only-a.txt'))).toBe(false);
  });

  it('404s for an item that does not exist', async () => {
    const res = await agent().post('/items/no-such-item/worktree').send({ root });
    expect(res.status).toBe(404);
  });

  it('refuses a root outside the worktree area', async () => {
    // Without this the endpoint is arbitrary directory creation plus a full
    // repo checkout anywhere the server user can write — on a route any local
    // process can reach.
    const item = await makeItem();
    const res = await agent().post(`/items/${item.id}/worktree`)
      .send({ root: path.join(os.tmpdir(), 'somewhere-else') });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/must be inside/i);
  });

  it('refuses a root that escapes the base with ..', async () => {
    const item = await makeItem();
    const res = await agent().post(`/items/${item.id}/worktree`)
      .send({ root: path.join(defaultWorktreeRoot(), '..', '..', 'escaped') });
    expect(res.status).toBe(400);
  });

  it('refuses when the project has no projectRoot, instead of guessing one', async () => {
    // Guessing would run git somewhere the user never pointed us at.
    const bare = await agent().post('/projects').send({ name: `bare-${Date.now()}` });
    const item = (await agent().post('/items')
      .send({ type: 'TASK', title: 'Orphan', projectId: bare.body.id })).body;

    const res = await agent().post(`/items/${item.id}/worktree`).send({ root });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/projectRoot/i);
  });

  it('reports a clear error when projectRoot is not a git repository', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wtapi-norepo-'));
    const p = await agent().post('/projects').send({ name: `norepo-${Date.now()}` });
    await storage.updateProject(p.body.id, { projectRoot: notARepo } as never);
    const item = (await agent().post('/items')
      .send({ type: 'TASK', title: 'No repo', projectId: p.body.id })).body;

    const res = await agent().post(`/items/${item.id}/worktree`).send({ root });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not a git repository/i);
  });
});

describe('GET /items/:id/worktree', () => {
  it('reports nothing before one exists', async () => {
    const item = await makeItem();
    const res = await agent().get(`/items/${item.id}/worktree`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBeNull();
  });

  it('reports the worktree once created', async () => {
    const item = await makeItem();
    const created = await agent().post(`/items/${item.id}/worktree`).send({ root });
    const res = await agent().get(`/items/${item.id}/worktree`);
    expect(res.body.path).toBe(created.body.path);
    expect(res.body.exists).toBe(true);
  });

  it('says the directory is gone when someone deleted it by hand', async () => {
    // The path stays recorded; `exists: false` is how a caller knows to
    // recreate rather than assume it can cd there.
    const item = await makeItem();
    const created = await agent().post(`/items/${item.id}/worktree`).send({ root });
    fs.rmSync(created.body.path, { recursive: true, force: true });

    const res = await agent().get(`/items/${item.id}/worktree`);
    expect(res.body.path).toBe(created.body.path);
    expect(res.body.exists).toBe(false);
  });
});

describe('DELETE /items/:id/worktree', () => {
  it('removes the directory and forgets the path', async () => {
    const item = await makeItem();
    const created = await agent().post(`/items/${item.id}/worktree`).send({ root });

    const res = await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!);
    expect(res.status).toBe(200);
    expect(fs.existsSync(created.body.path)).toBe(false);
    expect((await agent().get(`/items/${item.id}`)).body.worktreePath).toBeFalsy();
  });

  it('never destroys committed work — the branch survives', async () => {
    // This is the guarantee that makes removal safe to automate. Deleting a
    // worktree must cost you a checkout, never a commit.
    const item = await makeItem();
    const created = await agent().post(`/items/${item.id}/worktree`).send({ root });
    fs.writeFileSync(path.join(created.body.path, 'work.txt'), 'work');
    git(created.body.path, 'add', '.');
    git(created.body.path, 'commit', '-m', 'agent work');
    const sha = git(created.body.path, 'rev-parse', 'HEAD').trim();

    await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!);

    const branch = (await agent().get(`/items/${item.id}`)).body.branchName;
    expect(branch).toBeTruthy();

    // `git rev-parse <sha>` echoes ANY 40-hex string back without consulting
    // the object database — an earlier version of this test used it and proved
    // nothing. `cat-file -e` is the real existence check.
    expect(() => git(repo, 'cat-file', '-e', sha)).not.toThrow();
    // And the branch must still point at that commit, with its message intact.
    expect(git(repo, 'log', '-1', '--format=%s', branch).trim()).toBe('agent work');
    // The checkout, by contrast, is gone.
    expect(fs.existsSync(created.body.path)).toBe(false);
  });

  it('removes a worktree with uncommitted changes rather than refusing forever', async () => {
    const item = await makeItem();
    const created = await agent().post(`/items/${item.id}/worktree`).send({ root });
    fs.writeFileSync(path.join(created.body.path, 'dirty.txt'), 'uncommitted');

    expect((await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!)).status).toBe(200);
    expect(fs.existsSync(created.body.path)).toBe(false);
  });

  it('is idempotent — deleting twice is not an error', async () => {
    const item = await makeItem();
    await agent().post(`/items/${item.id}/worktree`).send({ root });
    await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!);
    expect((await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!)).status).toBe(200);
  });

  it('is a no-op for an item that never had one', async () => {
    const item = await makeItem();
    expect((await agent().delete(`/items/${item.id}/worktree`).set('x-agenfk-internal', VERIFY_TOKEN!)).status).toBe(200);
  });
});

describe('auto-worktree on entering a working step', () => {
  /** Advance an item one step, the way `agenfk verify` does. */
  const advance = (itemId: string) =>
    agent()
      .post(`/items/${itemId}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'starting work' });

  it('gives the item a worktree when it leaves TODO', async () => {
    const item = await makeItem('Auto one');
    expect((await agent().get(`/items/${item.id}/worktree`)).body.path).toBeNull();

    await advance(item.id);

    const wt = (await agent().get(`/items/${item.id}/worktree`)).body;
    expect(wt.path).toBeTruthy();
    expect(wt.exists).toBe(true);
  });

  it('does nothing when the project has not opted in', async () => {
    // autoWorktree is off by default: creating directories on someone's disk
    // because they advanced a card is not a reasonable default.
    await agent().put(`/projects/${projectId}`).send({ autoWorktree: false });
    const item = await makeItem('No auto');

    await advance(item.id);

    expect((await agent().get(`/items/${item.id}/worktree`)).body.path).toBeNull();
  });

  it('reuses the worktree on later steps instead of making another', async () => {
    const item = await makeItem('Auto two');
    await advance(item.id);
    const first = (await agent().get(`/items/${item.id}/worktree`)).body.path;

    await advance(item.id);

    expect((await agent().get(`/items/${item.id}/worktree`)).body.path).toBe(first);
  });

  it('still advances the item when the worktree cannot be created', async () => {
    // A broken git setup must not block the workflow. The transition is the
    // user's intent; the worktree is a convenience on top of it.
    const p = await agent().post('/projects').send({ name: `broken-${Date.now()}` });
    await storage.updateProject(p.body.id, { projectRoot: '/nonexistent/path' } as never);
    await agent().put(`/projects/${p.body.id}`).send({ autoWorktree: true });
    const item = (await agent().post('/items')
      .send({ type: 'TASK', title: 'Broken repo', projectId: p.body.id })).body;

    const res = await advance(item.id);

    expect(res.status).toBe(200);
    expect((await agent().get(`/items/${item.id}`)).body.status).not.toBe('TODO');
  });
});

describe('project root must never become the home directory (CGLAB-166 review)', () => {
  it('does not place worktrees under ~/.agenfk', () => {
    // findProjectRoot walks UP looking for a `.agenfk` directory. Put the
    // worktrees under ~/.agenfk and the walk from inside one lands on $HOME —
    // and then autoGitCommit runs `git add -A && git commit` in the user's
    // home directory, staging ~/.ssh and ~/.aws for anyone with dotfiles in
    // git. The location itself is the fix.
    const root = defaultWorktreeRoot();
    // Separator included on purpose: without it ".agenfk-worktrees" reads as
    // being inside ".agenfk".
    expect(root.startsWith(path.join(os.homedir(), '.agenfk') + path.sep)).toBe(false);
    expect(root.startsWith(os.homedir())).toBe(true);
  });

  it('never resolves a worktree path to the home directory', () => {
    // The dangerous case, stated directly: walking up from a worktree must not
    // land on $HOME just because ~/.agenfk exists there. If it does,
    // `agenfk verify` from that worktree persists projectRoot as $HOME and
    // autoGitCommit then runs `git add -A && git commit` over the user's
    // dotfiles.
    const insideAgenfkHome = path.join(os.homedir(), '.agenfk', 'worktrees', 'repo', 'leaf');
    expect(findProjectRoot(insideAgenfkHome)).not.toBe(os.homedir());

    const atNewRoot = path.join(defaultWorktreeRoot(), 'repo', 'leaf');
    expect(findProjectRoot(atNewRoot)).not.toBe(os.homedir());
  });

  it('still resolves a real project root normally', () => {
    expect(findProjectRoot(repo)).toBe(repo);
  });
});
