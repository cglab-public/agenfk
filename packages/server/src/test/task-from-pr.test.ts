/**
 * @vitest-environment node
 *
 * A card from an existing Pull Request (CGLAB-177).
 *
 * Sibling of `tasks-from-branch`, and everything interesting here is a
 * difference from it. That route starts from a branch the user names; this one
 * starts from a PR that already exists, which brings three problems it does not
 * have — the branch is REMOTE, the PR may come from a fork, and a card for that
 * branch may already be on the board.
 *
 * `gh` is faked on PATH rather than mocked at the module boundary. The route
 * shells out, so a module mock would test a seam that does not exist in
 * production and would pass even if the argv were wrong. A script on PATH is
 * exercised by the same `execFileSync` the real one is.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app, initStorage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./task-from-pr-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let repo: string;
let origin: string;
let binDir: string;
let projectId: string;
let realPath: string;

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

/**
 * A repo with a real `origin` holding a real branch.
 *
 * The fetch is the part of this route that only exists because the branch is
 * remote, so faking it away would remove the thing under test.
 */
const makeRepoWithOrigin = (): { repo: string; origin: string } => {
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  git(dir, 'remote', 'add', 'origin', originDir);
  git(dir, 'push', '-q', 'origin', 'main');
  // The PR's head branch, pushed and then removed locally — exactly the state a
  // reviewer's machine is in when they open somebody else's PR.
  git(dir, 'checkout', '-qb', 'feat/from-pr');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  git(dir, 'push', '-q', 'origin', 'feat/from-pr');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-qD', 'feat/from-pr');
  /*
   * The tracking ref goes too, and this line is the whole fixture.
   *
   * The first version used `git remote prune origin`, which only drops refs
   * for branches GONE from the remote — feat/from-pr is still there, so it did
   * nothing, refs/remotes/origin/feat/from-pr survived, and the route's fetch
   * was a no-op in every test. Deleting the fetch line entirely would have
   * kept the suite green. Found in review.
   */
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/feat/from-pr');
  return { repo: dir, origin: originDir };
};

/** A `gh` that answers from an env var, so each test states its own PR. */
const installFakeGh = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-bin-'));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    'if [ -n "$AGENFK_TEST_PR_FAIL" ]; then echo "no pull requests found" >&2; exit 1; fi',
    // ONE ARGUMENT PER LINE. `echo "$@"` joins them with spaces, so
    // `gh "pr view 42" -R acme/app` printed exactly what the correct form
    // printed — the assertion that cites the shell-injection bug could not
    // tell them apart. Found in review.
    'printf "%s\\n" "$@" > "$AGENFK_TEST_GH_ARGV"',
    'printf %s "$AGENFK_TEST_PR_JSON"',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  return dir;
};

const setPr = (over: Record<string, unknown> = {}) => {
  process.env.AGENFK_TEST_PR_JSON = JSON.stringify({
    number: 42,
    title: 'Make the thing faster',
    body: 'Caches the lookup.',
    url: 'https://github.com/acme/app/pull/42',
    headRefName: 'feat/from-pr',
    state: 'OPEN',
    isCrossRepository: false,
    ...over,
  });
};

const post = (body: Record<string, unknown>) =>
  request(app).post(`/projects/${projectId}/tasks-from-pr`).send(body);

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  binDir = installFakeGh();
  realPath = process.env.PATH ?? '';
});
afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  fs.rmSync(binDir, { recursive: true, force: true });
  process.env.PATH = realPath;
});

beforeEach(async () => {
  await initStorage();
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  process.env.AGENFK_TEST_GH_ARGV = path.join(binDir, 'argv.txt');
  delete process.env.AGENFK_TEST_PR_FAIL;
  setPr();

  const made = makeRepoWithOrigin();
  repo = made.repo; origin = made.origin;

  const p = await internal(request(app).post('/projects')).send({ name: 'from-pr' });
  projectId = p.body.id;
  const seed = await request(app).post('/items').send({ title: 'seed', type: 'TASK', projectId });
  await internal(request(app).post(`/items/${seed.body.id}/validate`))
    .send({ cwd: repo, evidence: 'set the project root' });

  // `loadGitHubConfig` reads this. HOME is pinned to a sandbox by the root
  // vitest config, so writing it here touches nothing of the user's.
  const cfgDir = path.join(os.homedir(), '.agenfk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'),
    JSON.stringify({ github: { repos: { [projectId]: { owner: 'acme', repo: 'app' } } } }));
});

afterEach(() => {
  /*
   * The worktree goes too, and unconditionally.
   *
   * Removing it inline at the end of a test only runs when the test PASSES —
   * so a failing run left a directory behind, and leftover worktrees are how
   * a suite starts failing for reasons that belong to an earlier run. This
   * epic already has a card open on rotating failures; not adding to it.
   */
  const worktreeRoot = path.join(os.homedir(), '.agenfk', 'worktrees', path.basename(repo));
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
});

describe('POST /projects/:id/tasks-from-pr', () => {
  it('creates a card carrying the PR title, body and link', async () => {
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe('Make the thing faster');
    expect(res.body.item.description).toContain('Caches the lookup.');
    expect(res.body.item.description).toContain('https://github.com/acme/app/pull/42');
    expect(res.body.item.branchName).toBe('feat/from-pr');
    expect(res.body.item.prNumber).toBe(42);
  });

  it("cuts the worktree on the PR's commits, not on local main", async () => {
    /*
     * THE test for this route, and the first version of it was worthless: it
     * asserted that a directory existed and nothing about what was in it, so
     * it passed while the worktree held local main under the PR's branch name.
     *
     * That is worse than failing. The card looks ready, the directory is named
     * after the PR, an agent works in it and pushes — and the push either
     * bounces or overwrites the contributor's branch.
     *
     * `f.txt` exists only on the PR's branch, so its presence is the whole
     * claim: these are the PR's commits.
     */
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(201);
    expect(res.body.worktree?.path, res.body.worktreeError ?? '').toBeTruthy();
    expect(fs.existsSync(path.join(res.body.worktree.path, 'f.txt')),
      'the worktree does not contain the PR\'s file — it was branched from local HEAD').toBe(true);
    expect(git(res.body.worktree.path, 'log', '-1', '--format=%s').trim()).toBe('work');
    fs.rmSync(res.body.worktree.path, { recursive: true, force: true });
  });

  it('passes the PR number as its own argv entry', async () => {
    // It reaches a shellout. The issue importer carries a comment naming the
    // bug this was (4c939916).
    await post({ prNumber: 42 });
    // Line by line, so a single joined argument cannot masquerade as four.
    const argv = fs.readFileSync(process.env.AGENFK_TEST_GH_ARGV!, 'utf8').split('\n');
    expect(argv.slice(0, 5)).toEqual(['pr', 'view', '42', '-R', 'acme/app']);
  });

  it('does not bring the PR conversation along', async () => {
    // Only the body. Comments and reviews go on changing on GitHub, and a
    // snapshot of them inside a card is a second copy nobody will update.
    setPr({ body: 'Just the body.' });
    const res = await post({ prNumber: 42 });
    expect(res.body.item.description).toBe('Just the body.\n\nPR #42: https://github.com/acme/app/pull/42');
  });
});

describe('a branch that already has a card', () => {
  it('opens that card instead of making a second', async () => {
    // Git allows one worktree per branch, so a second card on the same branch
    // is a failure scheduled for later.
    const first = await post({ prNumber: 42 });
    expect(first.status).toBe(201);
    if (first.body.worktree?.path) fs.rmSync(first.body.worktree.path, { recursive: true, force: true });

    const second = await post({ prNumber: 42 });
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(second.body.reason).toContain('one worktree per branch');
  });

  it('reuses a card made before the PR existed, matched on the branch', async () => {
    // Two calls, because `POST /items` does not take a branch — only `PUT`
    // does. The first version of this test sent it on the create and passed
    // nothing but its own assumption.
    const made = await request(app).post('/items')
      .send({ title: 'Started early', type: 'TASK', projectId });
    await request(app).put(`/items/${made.body.id}`).send({ branchName: 'feat/from-pr' });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(made.body.id);
  });
});

describe('when the worktree cannot be made', () => {
  it('keeps the card, because the PR exists whether or not the remote is reachable', async () => {
    // The deliberate divergence from tasks-from-branch, which rolls the item
    // back. There the item exists only to hold a worktree; here it represents
    // a PR, and deleting the user's card because a fetch failed would be the
    // tool arguing with them.
    git(repo, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'agenfk-no-such-remote'));
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(201);
    expect(res.body.item.id).toBeTruthy();
    expect(res.body.worktree).toBeNull();
  });

  it('says why, on the card, where it outlives the response', async () => {
    // A card that looks ready and has no worktree is the exact failure the
    // rollback over there exists to prevent. Silence is what is refused here,
    // not the card.
    git(repo, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'agenfk-no-such-remote'));
    const res = await post({ prNumber: 42 });
    expect(res.body.worktreeError).toBeTruthy();
    const item = await request(app).get(`/items/${res.body.item.id}`);
    expect(JSON.stringify(item.body.comments ?? [])).toContain('worktree was not');
  });

  it('does not even try for a PR from a fork', async () => {
    // The head branch is not on our remote, so the fetch would fail every
    // time. Spending a round trip to produce an error already known is worse
    // than saying so.
    setPr({ isCrossRepository: true });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(201);
    expect(res.body.worktreeSkipped).toContain('fork');
    expect(res.body.worktree).toBeNull();
  });
});

describe('what it refuses', () => {
  it('a PR number that is not a positive integer', async () => {
    for (const bad of ['1; rm -rf /', -1, 0, 1.5, 'abc', null, undefined]) {
      const res = await post({ prNumber: bad });
      expect(res.status, `should have refused ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('an agent that is not one we can launch', async () => {
    const res = await post({ prNumber: 42, agentId: 'rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('a project that does not exist', async () => {
    const res = await request(app).post('/projects/no-such-project/tasks-from-pr').send({ prNumber: 42 });
    expect(res.status).toBe(404);
  });

  it('a PR gh cannot read, without leaving a card behind', async () => {
    process.env.AGENFK_TEST_PR_FAIL = '1';
    const before = await request(app).get(`/items?projectId=${projectId}`);
    const res = await post({ prNumber: 999 });
    expect(res.status).toBe(404);
    const after = await request(app).get(`/items?projectId=${projectId}`);
    expect(after.body.length).toBe(before.body.length);
  });

  it('a project with no GitHub configured', async () => {
    fs.writeFileSync(path.join(os.homedir(), '.agenfk', 'config.json'), JSON.stringify({}));
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('GitHub not configured');
  });
});
