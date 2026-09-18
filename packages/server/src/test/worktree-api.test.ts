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
import { app, initStorage, storage, VERIFY_TOKEN, defaultWorktreeRoot, findProjectRoot, autoGitCommit } from '../server';

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

  it('refuses a root that escapes through a SYMLINK, not just through ..', async () => {
    /*
     * THE escape the other two could not see, and the reason this route was
     * reported as a real path-injection rather than a false positive.
     *
     * `path.resolve(x).startsWith(base)` collapses `..` and stops. It does not
     * follow links - so a path of innocent-looking segments under the worktree
     * area, where ONE segment points out, passes a lexical check and then
     * `git worktree add` checks out a whole repository at the link's target.
     *
     * The prerequisite is close to automatic in a workspace monorepo: `npm
     * install` inside a worktree creates `node_modules/@scope/pkg` links that
     * leave it, and this route has no token gate - any local process, or a page
     * on an allowed localhost origin, can drive it.
     *
     * Verified before the fix: the old guard returned true for exactly this.
     */
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-victim-'));
    const insideBase = path.join(defaultWorktreeRoot(), 'somerepo', 'wt-abc');
    fs.mkdirSync(insideBase, { recursive: true });
    const link = path.join(insideBase, 'escapes');
    try { fs.unlinkSync(link); } catch { /* first run */ }
    fs.symlinkSync(victim, link, 'dir');

    try {
      const item = await makeItem();
      const res = await agent().post(`/items/${item.id}/worktree`).send({ root: link });
      expect(res.status, 'a symlinked root was accepted').toBe(400);
      expect(String(res.body.error)).toMatch(/must be inside|symlink/i);
      // And nothing was written out there on the way to refusing.
      expect(fs.readdirSync(victim), 'it wrote outside the base before refusing').toEqual([]);
    } finally {
      try { fs.unlinkSync(link); } catch { /* best effort */ }
      fs.rmSync(victim, { recursive: true, force: true });
    }
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
    // and then the close commit runs `git -C $HOME commit` over whatever is
    // staged there, landing a stranger's dotfile work under a card's name for
    // anyone who keeps $HOME in git. The location itself is the fix.
    //
    // It used to be worse: the close ran `git add -A` first, so it STAGED
    // ~/.ssh and ~/.aws on the way. closeCommit.ts removed the staging; the
    // wrong-directory risk is what remains.
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
    // the close then commits whatever is staged there.
    const insideAgenfkHome = path.join(os.homedir(), '.agenfk', 'worktrees', 'repo', 'leaf');
    expect(findProjectRoot(insideAgenfkHome)).not.toBe(os.homedir());

    const atNewRoot = path.join(defaultWorktreeRoot(), 'repo', 'leaf');
    expect(findProjectRoot(atNewRoot)).not.toBe(os.homedir());
  });

  it('still resolves a real project root normally', () => {
    // A REAL root, marker included: without `.agenfk` the walk finds nothing
    // and the honest answer is null, which is the test above's point.
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fpr-real-'));
    fs.mkdirSync(path.join(realRoot, '.agenfk'), { recursive: true });
    try {
      expect(findProjectRoot(realRoot)).toBe(realRoot);
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The close commits the card's files, not the index (819e7192).
 *
 * commitStagedForCard has accepted a claims pathspec since it was written and
 * no caller ever passed one, so the narrowing it describes had never once
 * happened in production. Same defect class this card exists to fix, one layer
 * up: a mechanism complete, tested, and unreachable.
 *
 * WHY THIS CALLS autoGitCommit DIRECTLY RATHER THAN CLOSING A CARD. The close
 * is gated on `process.env.NODE_ENV !== 'test' && !process.env.VITEST`, so
 * walking an item to DONE runs no commit at all under vitest. That guard is
 * also the reason `git add -A` survived as long as it did: no test could reach
 * the line. Driving the function against a real repository is the closest this
 * gets to the real path without loosening a guard that exists to keep the
 * suite from committing to the developer's own checkout.
 *
 * The scenario is the one observed on 2026-09-15: three agents in one tree,
 * and the index holding two cards' work before either card closed.
 */
describe('a close takes only the closing card\'s files', () => {
  const card = (claims?: string[]) =>
    ({ id: 'card-0001', type: 'TASK', title: 'Owns its files', claims } as never);

  it('leaves another agent\'s staged file out of the commit', async () => {
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const mine = 1;\n');
    fs.writeFileSync(path.join(repo, 'theirs.ts'), 'export const theirs = 2;\n');
    // Both staged, which is the whole point: .git/index belongs to the
    // WORKTREE, not to an agent, so a sibling's `git add` lands here too.
    git(repo, 'add', 'mine.ts', 'theirs.ts');

    const outcome = await autoGitCommit(card(['mine.ts']), repo);
    expect(outcome.success, `the close did not commit: ${outcome.error ?? ''}`).toBe(true);

    const committed = git(repo, 'log', '-1', '--name-only', '--format=').trim().split('\n').filter(Boolean);
    expect(committed, 'the close swept a file this card never claimed').toEqual(['mine.ts']);
    // And the sibling's work is still exactly where they left it.
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('theirs.ts');
  });

  it('honours a directory claim, not just an exact file', async () => {
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg', 'deep.ts'), 'export const d = 1;\n');
    fs.writeFileSync(path.join(repo, 'outside.ts'), 'export const o = 2;\n');
    git(repo, 'add', 'pkg/deep.ts', 'outside.ts');

    await autoGitCommit(card(['pkg']), repo);

    const committed = git(repo, 'log', '-1', '--name-only', '--format=').trim().split('\n').filter(Boolean);
    expect(committed).toEqual(['pkg/deep.ts']);
  });

  it('still commits the whole index when the card claims nothing', async () => {
    /*
     * Every card in the database is in this state, so the narrowing must not
     * change what happens until a card opts in. Getting this wrong ships as a
     * close that silently commits nothing.
     */
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2;\n');
    git(repo, 'add', 'a.ts', 'b.ts');

    await autoGitCommit(card(), repo);

    const committed = git(repo, 'log', '-1', '--name-only', '--format=').trim().split('\n').filter(Boolean);
    expect(committed.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('declines when none of the card\'s own paths are staged', async () => {
    // With a pathspec the question stops being "is anything staged" and
    // becomes "is any of MINE staged". Committing here would either produce an
    // empty commit or land a sibling's file under this card's name.
    fs.writeFileSync(path.join(repo, 'theirs.ts'), 'export const t = 1;\n');
    git(repo, 'add', 'theirs.ts');
    const before = git(repo, 'rev-parse', 'HEAD').trim();

    const outcome = await autoGitCommit(card(['mine.ts']), repo);

    expect(outcome.success).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD').trim(), 'it committed anyway').toBe(before);
  });
});

/**
 * Declaring what a card owns, over the API (819e7192).
 *
 * The field, the storage and the gatekeeper check all landed before this, and
 * none of it was reachable: PUT /items/:id destructures an explicit allowlist
 * of fields, so `claims` arrived and was dropped without a word. A card could
 * only declare anything by writing to storage directly, which is what this
 * file's own earlier tests had to do.
 *
 * THE ROUTE REFUSES RATHER THAN STORING SOMETHING THAT PROTECTS NOTHING. A
 * glob persisted here is worse than no claim: claims.ts compares it as a
 * literal, so a card believing it holds `packages/**` holds a file with that
 * name, and every collision check it takes part in comes back clear.
 */
describe('PUT /items/:id and the claims field', () => {
  it('stores what the card says it owns', async () => {
    const item = await makeItem('Declares its files');
    const res = await agent().put(`/items/${item.id}`).send({ claims: ['packages/ui/', 'src/App.tsx'] });

    expect(res.status).toBe(200);
    expect(res.body.claims).toEqual(['packages/ui/', 'src/App.tsx']);
    // Round-trips, rather than living only in the response.
    expect((await agent().get(`/items/${item.id}`)).body.claims).toEqual(['packages/ui/', 'src/App.tsx']);
  });

  it('refuses a glob instead of storing one that protects nothing', async () => {
    const item = await makeItem('Wants a glob');
    const res = await agent().put(`/items/${item.id}`).send({ claims: ['packages/**'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('packages/**');
    expect((await agent().get(`/items/${item.id}`)).body.claims).toBeUndefined();
  });

  it('refuses a path that leaves the repository', async () => {
    const item = await makeItem('Wants to escape');
    for (const bad of ['../secrets', '/etc/passwd', 'a/../../b']) {
      const res = await agent().put(`/items/${item.id}`).send({ claims: [bad] });
      expect(res.status, `${bad} was accepted`).toBe(400);
    }
  });

  it('refuses a claim another card already holds, naming the holder', async () => {
    /*
     * Refusing at DECLARATION beats refusing at every edit afterwards: the
     * lead cutting a fan-out finds out while it can still re-cut the split,
     * rather than each agent discovering it one gatekeeper call at a time.
     */
    const holder = await makeItem('Holds the directory');
    await agent().put(`/items/${holder.id}`).send({ claims: ['packages/ui/'] });
    await agent().put(`/items/${holder.id}`).send({ status: 'IN_PROGRESS' });

    const late = await makeItem('Wants a file inside it');
    const res = await agent().put(`/items/${late.id}`).send({ claims: ['packages/ui/src/App.tsx'] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(holder.id);
  });

  it('lets a card re-declare its own claims', async () => {
    // A second dispatch, or a card widening what it owns. Colliding with
    // yourself is not a collision, and a card that could not re-declare would
    // be stuck after its first call.
    const item = await makeItem('Re-declares');
    await agent().put(`/items/${item.id}`).send({ claims: ['packages/cli/'] });
    const res = await agent().put(`/items/${item.id}`).send({ claims: ['packages/cli/', 'packages/cli/extra.ts'] });
    expect(res.status).toBe(200);
  });

  it('leaves claims alone when the request does not mention them', async () => {
    // Every other PUT in the app omits the field, and dropping the card's
    // claims on an unrelated title edit would silently release its files.
    const item = await makeItem('Keeps its claims');
    await agent().put(`/items/${item.id}`).send({ claims: ['packages/server/'] });
    await agent().put(`/items/${item.id}`).send({ title: 'Renamed' });
    expect((await agent().get(`/items/${item.id}`)).body.claims).toEqual(['packages/server/']);
  });
});

/**
 * `git commit -- <pathspec>` takes the WORKING TREE (review of ee57cb6f).
 *
 * The module says it commits what you staged. The pathspec broke exactly that:
 * adding a claim silently turned the close into `git add -A -- <claims> &&
 * git commit`. Found by an adversarial review and reproduced by hand before
 * being written down - index holding "reviewed", worktree holding
 * "unreviewed", commit taking the worktree.
 *
 * NO TEST IN THIS SUITE EVER MADE THE INDEX AND THE WORKING TREE DIFFER, which
 * is why 3999 green tests could not see it. Every case here does.
 */
describe('the close never takes unstaged content', () => {
  const card = (claims?: string[]) =>
    ({ id: 'card-drift', type: 'TASK', title: 'Owns its files', claims } as never);

  it('refuses when a claimed file changed after it was staged', async () => {
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const reviewed = 1;\n');
    git(repo, 'add', 'mine.ts');
    // The dangerous edit: after staging, before closing. Another agent inside
    // this card's claim, or the card itself being careless.
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const UNREVIEWED = 2;\n');
    const before = git(repo, 'rev-parse', 'HEAD').trim();

    const outcome = await autoGitCommit(card(['mine.ts']), repo);

    expect(outcome.success, 'it committed the working tree over the index').toBe(false);
    expect(outcome.error ?? '').toMatch(/staged and then changed again/i);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(before);
  });

  it('commits the staged bytes when nothing drifted', async () => {
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const reviewed = 1;\n');
    git(repo, 'add', 'mine.ts');

    expect((await autoGitCommit(card(['mine.ts']), repo)).success).toBe(true);
    expect(git(repo, 'show', 'HEAD:mine.ts')).toContain('reviewed');
  });

  it('ignores drift in a file this card does not claim', async () => {
    // A sibling editing its OWN files must not block this card's close - that
    // would make every close depend on everybody else standing still.
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const mine = 1;\n');
    fs.writeFileSync(path.join(repo, 'theirs.ts'), 'export const theirs = 1;\n');
    git(repo, 'add', 'mine.ts', 'theirs.ts');
    fs.writeFileSync(path.join(repo, 'theirs.ts'), 'export const theirs = 2;\n');

    expect((await autoGitCommit(card(['mine.ts']), repo)).success).toBe(true);
    const committed = git(repo, 'log', '-1', '--name-only', '--format=').trim().split('\n').filter(Boolean);
    expect(committed).toEqual(['mine.ts']);
  });

  it('closes when the card claims a directory it has not created yet', async () => {
    /*
     * `git commit -- docs` where docs/ does not exist is a hard error -
     * "pathspec 'docs' did not match any file(s) known to git" - and the card
     * could never close. The pathspec is now the STAGED FILES, which git has
     * just told us about, rather than the claims themselves.
     */
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const mine = 1;\n');
    git(repo, 'add', 'mine.ts');

    const outcome = await autoGitCommit(card(['mine.ts', 'docs/']), repo);
    expect(outcome.success, `a claim on a future directory blocked the close: ${outcome.error ?? ''}`).toBe(true);
  });

  it('matches a claim spelled with backslashes, as the gate says it does', async () => {
    // The old filter was a raw string compare and disagreed with claimsCollide
    // on exactly the spellings the gate accepts as equivalent.
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg', 'deep.ts'), 'export const d = 1;\n');
    git(repo, 'add', 'pkg/deep.ts');

    expect((await autoGitCommit(card(['pkg\\']), repo)).success).toBe(true);
    expect(git(repo, 'log', '-1', '--name-only', '--format=')).toContain('pkg/deep.ts');
  });
});

/**
 * Pairing a card with an issue in another tracker (af47b248).
 *
 * `externalId` has been declared in types.ts since before this route existed
 * and dropped by its destructure ever since, so not one item in the database
 * carried one - measured at 0 of 160 on the day twelve issues were created in
 * JIRA for this very work. The same shape as `claims`: a field complete at
 * both ends with nothing joining them.
 */
describe('PUT /items/:id and the external issue key', () => {
  it('stores the key and the link', async () => {
    const item = await makeItem('Paired with an issue');
    const res = await agent().put(`/items/${item.id}`)
      .send({ externalId: 'CGLAB-195', externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-195' });

    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe('CGLAB-195');
    const fetched = (await agent().get(`/items/${item.id}`)).body;
    expect(fetched.externalId, 'the key did not survive a round trip').toBe('CGLAB-195');
    expect(fetched.externalUrl).toContain('CGLAB-195');
  });

  it('leaves the pairing alone when the request does not mention it', async () => {
    /*
     * THE test. Every other PUT in the app omits these fields, so clearing
     * them on an unrelated edit would unpair a card the moment somebody
     * renamed it - and nothing would say so.
     */
    const item = await makeItem('Keeps its pairing');
    await agent().put(`/items/${item.id}`).send({ externalId: 'CGLAB-200' });
    await agent().put(`/items/${item.id}`).send({ title: 'Renamed' });

    const fetched = (await agent().get(`/items/${item.id}`)).body;
    expect(fetched.externalId, 'renaming a card unpaired it').toBe('CGLAB-200');
  });
});

/**
 * What the card staged and never claimed (CGLAB-198).
 *
 * The two halves existed and nothing joined them: the close already reads the
 * index, and claims.ts already decides overlap. This asks the question.
 *
 * IT REPORTS, IT DOES NOT BLOCK. An agent can touch a file legitimately and
 * forget to widen its claim; turning that into a refusal at close time
 * punishes the common case to catch the rare one. The value is the pattern
 * over time - a claim that is systematically too narrow shows up as a habit.
 */
describe('files staged outside the claim', () => {
  const card = (claims?: string[]) =>
    ({ id: 'card-outside', type: 'TASK', title: 'Owns a little', claims } as never);

  it('names them, and closes anyway', async () => {
    // THE test. If this ever blocks, the report has become a gate and the
    // card has changed into something nobody asked for.
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'stray.ts'), 'export const b = 2;\n');
    git(repo, 'add', 'mine.ts', 'stray.ts');

    const outcome = await autoGitCommit(card(['mine.ts']), repo);

    expect(outcome.success, 'the report became a gate').toBe(true);
    expect(outcome.outsideClaims).toEqual(['stray.ts']);
  });

  it('reports nothing when everything staged was claimed', async () => {
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const a = 1;\n');
    git(repo, 'add', 'mine.ts');
    expect((await autoGitCommit(card(['mine.ts']), repo)).outsideClaims).toEqual([]);
  });

  it('reports nothing when the card claimed nothing, which is most of them', async () => {
    /*
     * Holds BY CONSTRUCTION rather than by a guard: with no claims `mine` is
     * everything staged, so the difference is empty. Written as an explicit
     * guard first, and a mutation showed the guard prevented nothing - the
     * property is real, the defence of it was decorative.
     */
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git(repo, 'add', 'a.ts');
    expect((await autoGitCommit(card(), repo)).outsideClaims).toEqual([]);
  });

  it('counts a file under a claimed DIRECTORY as claimed', async () => {
    // It asks claimsCollide, so a directory claim covers what is beneath it -
    // a report that listed those would be wrong and loud.
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg', 'deep.ts'), 'export const d = 1;\n');
    git(repo, 'add', 'pkg/deep.ts');
    expect((await autoGitCommit(card(['pkg/']), repo)).outsideClaims).toEqual([]);
  });

  it('reports them even when the close declines for having nothing of ours', async () => {
    /*
     * The most useful moment to say it: the agent staged only files it does
     * not own, so the close refuses - and "nothing was staged" alone would be
     * baffling when the tree plainly has staged files.
     */
    fs.writeFileSync(path.join(repo, 'stray.ts'), 'export const b = 2;\n');
    git(repo, 'add', 'stray.ts');

    const outcome = await autoGitCommit(card(['mine.ts']), repo);
    expect(outcome.success).toBe(false);
    expect(outcome.outsideClaims).toEqual(['stray.ts']);
  });
});
