/**
 * @vitest-environment node
 *
 * CGLAB-366 / BUG 6da961dc — `agenfk verify` must run against the tree the
 * card's work actually lives in.
 *
 * Observed 2026-09-22, closing a card from a git worktree while another agent
 * worked in the main checkout:
 *   - the verifyCommand ran in projectRoot (the OTHER agent's checkout), so the
 *     DONE gate validated a tree that did not contain the card's change;
 *   - the close commit read projectRoot's index, reported "Nothing was staged",
 *     and committed nothing, although the worktree had the card's files staged;
 *   - and, the worst of the three: a verify run from a worktree that carried a
 *     `.agenfk` marker RECORDED that worktree as the project's projectRoot,
 *     repointing every card in the project at one card's directory.
 *
 * Branches and worktrees are tracked on top-level items only, so a child card
 * has no worktreePath of its own — its tree is its top-level ancestor's.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app, initStorage, VERIFY_TOKEN, autoGitCommit } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });

const TEST_DB = path.resolve('./verify-worktree-root-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Writes the directory it ran in, so a test can see WHERE the command ran. */
const MARK = `node -e "require('fs').writeFileSync('ran-here.txt', process.cwd())"`;

let repo: string;
let scratch: string[];
let projectId: string;

const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  scratch.push(d);
  return d;
};

const makeRepo = (): string => {
  const dir = tmp('agenfk-vwr-main-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  // The marker that makes this directory a project root for the walk-up.
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  return dir;
};

/** A linked worktree of `repo`, made the way `git worktree add` makes one. */
const linkedWorktree = (branch: string): string => {
  const wt = path.join(tmp('agenfk-vwr-wt-'), 'tree');
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
};

/**
 * Give a card its worktree the supported way - the endpoint `agenfk worktree
 * create` calls, which records worktreePath on the card. (PUT /items does not
 * accept worktreePath; setting it there is silently ignored.)
 */
const cardWorktree = async (itemId: string): Promise<string> => {
  // The endpoint names the branch from the card (item.branchName, else one
  // built from its type and title); it takes no branch in the body.
  const made = await internal(agent().post(`/items/${itemId}/worktree`)).send({});
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  const wt = made.body.path as string;
  expect((await agent().get(`/items/${itemId}`)).body.worktreePath).toBe(wt);
  scratch.push(wt);
  return wt;
};

const projectRoot = async (): Promise<string | undefined> => {
  const res = await agent().get('/projects');
  return res.body.find((p: any) => p.id === projectId)?.projectRoot;
};

/** Switch the test to a fresh project whose root a verify from `dir` sets. */
const projectRootedAt = async (dir: string) => {
  const p = await internal(agent().post('/projects')).send({ name: `vwr-${Date.now()}` });
  projectId = p.body.id;
  const seed = await newItem('TASK', 'seed');
  await validate(seed.id, { cwd: dir });
};

/** A repository with no `.agenfk` marker anywhere, so a verify from it records nothing. */
const unmarkedRepo = (): string => {
  const dir = tmp('agenfk-vwr-unrelated-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'x');
  return dir;
};

const newItem = async (type: string, title: string, parentId?: string) =>
  (await agent().post('/items').send({ title, type, projectId, ...(parentId ? { parentId } : {}) })).body;

const validate = (itemId: string, body: Record<string, unknown>) =>
  internal(agent().post(`/items/${itemId}/validate`)).send({ evidence: 'test', ...body });

/**
 * Advance one step with no command. Leaving TODO never runs a command (the
 * anchor advance is by design command-free), so every test that asserts WHERE
 * a command ran first steps the card into a working step with this.
 */
const step = (itemId: string) => validate(itemId, {});

describe('verify runs against the card\'s own tree (CGLAB-366)', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  beforeEach(async () => {
    scratch = [];
    await initStorage();
    repo = makeRepo();
    const p = await internal(agent().post('/projects')).send({ name: 'verify-worktree-root' });
    projectId = p.body.id;
    // The supported way to set projectRoot: a verify reporting where it ran.
    const seed = await newItem('TASK', 'seed');
    await validate(seed.id, { cwd: repo });
    expect(await projectRoot()).toBe(repo);
  });
  afterEach(() => {
    for (const d of scratch.reverse()) fs.rmSync(d, { recursive: true, force: true });
  });

  it('runs the verify command in the card\'s worktree, not in projectRoot', async () => {
    const task = await newItem('TASK', 'has its own worktree');
    const wt = await cardWorktree(task.id);
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: wt });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt')), 'command did not run in the worktree').toBe(true);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt')), 'command ran in projectRoot').toBe(false);
  });

  it('runs a CHILD card\'s verify in its top-level ancestor\'s worktree', async () => {
    // Children never carry a worktreePath: branches are tracked on top-level
    // items only. Their tree is the ancestor's.
    const epic = await newItem('EPIC', 'owns the worktree');
    const story = await newItem('STORY', 'child story', epic.id);
    const task = await newItem('TASK', 'grandchild task', story.id);
    const wt = await cardWorktree(epic.id);
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: wt });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt')), 'grandchild did not run in the epic\'s worktree').toBe(true);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt')), 'grandchild ran in projectRoot').toBe(false);
  });

  it('makes a child\'s close commit in its ancestor\'s worktree, from what was staged there', async () => {
    // Called directly: the validate route skips the close commit under vitest
    // (it would commit into the developer's repo), so this drives the function
    // every close path goes through, with a real child card in storage whose
    // epic owns a real worktree.
    const epic = await newItem('EPIC', 'owns the worktree');
    const bug = await newItem('BUG', 'child bug that closes', epic.id);
    const wt = await cardWorktree(epic.id);
    const mainHead = git(repo, 'rev-parse', 'main');

    fs.writeFileSync(path.join(wt, 'fix.txt'), 'the fix\n');
    git(wt, 'add', 'fix.txt');

    const child = (await agent().get(`/items/${bug.id}`)).body;
    expect(child.worktreePath ?? null, 'a child carries no worktree of its own').toBeNull();
    const r = await autoGitCommit(child, repo);

    expect(r.committed, JSON.stringify(r)).toBe(true);
    expect(git(wt, 'log', '-1', '--pretty=%s')).toMatch(/^close\(bug\): child bug that closes/);
    expect(git(wt, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('fix.txt');
    expect(git(repo, 'rev-parse', 'main'), 'the main checkout\'s branch moved').toBe(mainHead);
  });

  it('never records a linked worktree as projectRoot, even one carrying a .agenfk marker', async () => {
    // The incident: a hand-made marker defeated the "worktrees have no
    // .agenfk" assumption, and one card's tree became the whole project's root.
    const task = await newItem('TASK', 'runs from a marked worktree');
    const wt = linkedWorktree('feat/marked');
    fs.mkdirSync(path.join(wt, '.agenfk'), { recursive: true });

    await validate(task.id, { cwd: wt });
    expect(await projectRoot()).toBe(repo);
  });

  it('refuses when the caller is in a different tree and the card has no worktree', async () => {
    // With no worktree on the card, the server would fall back to projectRoot
    // and validate a tree the caller is not working in. Say so instead.
    const task = await newItem('TASK', 'caller elsewhere');
    const wt = linkedWorktree('feat/elsewhere');
    await step(task.id);
    const before = (await agent().get(`/items/${task.id}`)).body.status;

    const res = await validate(task.id, { command: MARK, cwd: wt });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/worktree/i);
    expect(res.body.error).toContain(wt);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt')), 'ran in projectRoot anyway').toBe(false);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt')), 'ran in the caller\'s tree').toBe(false);
    expect((await agent().get(`/items/${task.id}`)).body.status).toBe(before);
  });

  it('still runs in projectRoot when the caller IS in projectRoot, from a subdirectory', async () => {
    const task = await newItem('TASK', 'caller in the main checkout');
    const sub = path.join(repo, 'packages', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: sub });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(true);
  });

  it('keeps today\'s behaviour for a caller that sends no cwd (older CLIs)', async () => {
    const task = await newItem('TASK', 'no cwd reported');
    await step(task.id);
    const res = await validate(task.id, { command: MARK });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(true);
  });

  // ── review round 1 ───────────────────────────────────────────────────────

  it('accepts a project whose .agenfk marker sits in a SUBDIRECTORY of the repo (B1)', async () => {
    // A monorepo subproject: projectRoot is repo/services/api, while git's
    // top-level is repo. Comparing a git top-level with projectRoot itself
    // refused every verify from everywhere, the project directory included.
    fs.rmSync(path.join(repo, '.agenfk'), { recursive: true, force: true });
    const sub = path.join(repo, 'services', 'api');
    fs.mkdirSync(path.join(sub, '.agenfk'), { recursive: true });
    await projectRootedAt(sub);
    expect(await projectRoot()).toBe(sub);

    const task = await newItem('TASK', 'in a subproject');
    await step(task.id);
    const res = await validate(task.id, { command: MARK, cwd: sub });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(sub, 'ran-here.txt'))).toBe(true);
  });

  it('still runs in projectRoot for a caller in an UNRELATED repository (S1)', async () => {
    // A different repository is not "the wrong checkout of this one": running
    // in projectRoot is correct there, and it worked before this change.
    const elsewhere = unmarkedRepo();
    const task = await newItem('TASK', 'verified from another repo');
    await step(task.id);
    const res = await validate(task.id, { command: MARK, cwd: elsewhere });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(true);
  });

  it('refuses when the card\'s worktree is elsewhere and the caller works in the main checkout (S3)', async () => {
    // The incident mirrored: the suite would run in the epic's worktree,
    // which does not hold the caller's edits, and the close would read that
    // worktree's empty index.
    const epic = await newItem('EPIC', 'owns a worktree');
    const task = await newItem('TASK', 'edited in the main checkout', epic.id);
    const wt = await cardWorktree(epic.id);
    await step(task.id);
    const before = (await agent().get(`/items/${task.id}`)).body.status;

    const res = await validate(task.id, { command: MARK, cwd: repo });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(wt);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt'))).toBe(false);
    expect((await agent().get(`/items/${task.id}`)).body.status).toBe(before);
  });

  it('says the worktree is gone instead of failing to spawn a shell (S4)', async () => {
    const task = await newItem('TASK', 'worktree deleted by hand');
    const wt = await cardWorktree(task.id);
    fs.rmSync(wt, { recursive: true, force: true });
    await step(task.id);
    const before = (await agent().get(`/items/${task.id}`)).body.status;

    const res = await validate(task.id, { command: MARK });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(wt);
    expect(res.body.error).toMatch(/no longer exists/i);
    expect((await agent().get(`/items/${task.id}`)).body.status).toBe(before);
  });

  it('records a checkout of a bare-repo layout as projectRoot - there is no main checkout (S6)', async () => {
    // `git clone --bare` + `git worktree add`: EVERY checkout is a linked
    // worktree, so "never record a linked worktree" must not mean "never
    // record anything" here.
    const bare = path.join(tmp('agenfk-vwr-bare-'), 'repo.git');
    git(repo, 'clone', '-q', '--bare', repo, bare);
    const wt = path.join(tmp('agenfk-vwr-bare-wt-'), 'main');
    execFileSync('git', ['--git-dir', bare, 'worktree', 'add', '-q', wt, 'main'], { stdio: 'pipe' });
    fs.mkdirSync(path.join(wt, '.agenfk'), { recursive: true });

    await projectRootedAt(wt);
    expect(await projectRoot()).toBe(wt);
  });

  // ── the caller's cwd is matched, never trusted (CodeQL #136-139) ─────────
  //
  // `cwd` comes off the request body. Once a card has a tree to test, the
  // server asks git for every checkout of THAT tree's repository and matches
  // the caller's path against the list; it no longer runs git or touches the
  // filesystem inside whatever directory the caller named.

  it('does not repoint projectRoot at ANOTHER project\'s checkout the caller verified from', async () => {
    // A marked main checkout of a different repository: before, a verify
    // issued from there re-recorded it as THIS project's root, and the run
    // and every later close aimed at somebody else's repository.
    const other = makeRepo();
    const task = await newItem('TASK', 'verified from another project');
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: other });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await projectRoot()).toBe(repo);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(true);
    expect(fs.existsSync(path.join(other, 'ran-here.txt')), 'ran in the other project').toBe(false);
  });

  it('refuses a cwd that is a link inside projectRoot pointing at another worktree of the repo', async () => {
    // Textually inside projectRoot, really inside a different checkout. The
    // match has to be made on the resolved path as well, or one symlink turns
    // "another checkout" into "this one".
    const task = await newItem('TASK', 'caller behind a link');
    const wt = linkedWorktree('feat/behind-link');
    const link = path.join(repo, 'wt-link');
    fs.symlinkSync(wt, link, 'dir');
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: link });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(wt);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt'))).toBe(false);
  });

  it('refuses a caller in a worktree NESTED inside projectRoot: the deepest checkout wins', async () => {
    // repo/.worktrees/x is a prefix-match for BOTH repo and the worktree. The
    // caller is in the worktree, so it is the other checkout that counts.
    const task = await newItem('TASK', 'caller in a nested worktree');
    const nested = path.join(repo, '.worktrees', 'x');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/nested', nested);
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: nested });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(nested);
    expect(fs.existsSync(path.join(repo, 'ran-here.txt'))).toBe(false);
  });

  it('runs in the card\'s worktree for a caller in a subdirectory of it', async () => {
    const task = await newItem('TASK', 'caller deep in the card tree');
    const wt = await cardWorktree(task.id);
    const sub = path.join(wt, 'packages', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: sub });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt'))).toBe(true);
    expect(await projectRoot()).toBe(repo);
  });

  it('corrects a recorded projectRoot that is a linked worktree, from a verify in the main checkout', async () => {
    // A root recorded before CGLAB-366 (or set by hand) exists on disk, so
    // "learn only when there is no root" would keep it for good. The STORED
    // value's own validity decides whether it may be replaced.
    const wt = linkedWorktree('feat/was-recorded');
    const set = await internal(agent().put(`/projects/${projectId}/project-root`)).send({ projectRoot: wt });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const task = await newItem('TASK', 'verified from the real root');

    await validate(task.id, { cwd: repo });
    expect(await projectRoot()).toBe(repo);
  });

  it('does not refuse a caller sitting in the directory of a BARE repository', async () => {
    // `git worktree list` names the bare directory first, flagged `bare`. It
    // is not a checkout: nothing there can be "a different checkout".
    const bare = path.join(tmp('agenfk-vwr-bare2-'), 'repo.git');
    git(repo, 'clone', '-q', '--bare', repo, bare);
    const wt = path.join(tmp('agenfk-vwr-bare2-wt-'), 'main');
    execFileSync('git', ['--git-dir', bare, 'worktree', 'add', '-q', wt, 'main'], { stdio: 'pipe' });
    fs.mkdirSync(path.join(wt, '.agenfk'), { recursive: true });
    await projectRootedAt(wt);
    const task = await newItem('TASK', 'caller in the bare dir');
    await step(task.id);

    const res = await validate(task.id, { command: MARK, cwd: bare });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(fs.existsSync(path.join(wt, 'ran-here.txt'))).toBe(true);
  });
});
