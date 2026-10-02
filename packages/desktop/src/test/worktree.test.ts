/**
 * @vitest-environment node
 *
 * CGLAB-169: where a card's terminal opens.
 *
 * The whole point of the feature is "one terminal per card, in that card's own
 * worktree". If the directory is ever resolved by guess or by fallback, the
 * feature quietly becomes "a terminal somewhere", and the agent commits to the
 * wrong branch. So every failure here has to be loud.
 *
 * The trap is `exists`. `GET /items/:id/worktree` returns it precisely because
 * "never created" and "created, then deleted by hand" need different handling:
 * the second is a stored path that no longer resolves, and opening a shell in
 * it fails with a message about a missing directory rather than about a
 * worktree that needs recreating.
 *
 * There is a live example of the failure mode this guards against: BUG
 * b68254ec, where server.ts's cwd fallbacks resolve to a REAL directory under
 * the desktop app (the server is forked with cwd=packages/server/dist) instead
 * of to nothing, so a fallback that looks harmless silently picks a plausible
 * wrong answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveWorktree } from '../main/worktree';

const PORT = 3000;

/** A GET that answers /items/:id/worktree with whatever the test wants. */
const getReturning = (body: unknown, status = 200) =>
  vi.fn(async () => ({ status, body: JSON.stringify(body), contentType: 'application/json' }));

const postOk = (body: unknown) =>
  vi.fn(async () => ({ status: 201, body: JSON.stringify(body), contentType: 'application/json' }));

describe('resolving the directory a card’s terminal opens in', () => {
  it('uses the worktree the item already has', async () => {
    const get = getReturning({ path: '/tmp/wt/feat-x', branchName: 'feat/x', exists: true });
    const post = vi.fn();
    const result = await resolveWorktree('i1', { port: PORT, get, post });
    expect(result.cwd).toBe('/tmp/wt/feat-x');
    expect(result.branchName).toBe('feat/x');
    expect(post).not.toHaveBeenCalled();
  });

  it('recreates a worktree whose directory was deleted by hand', async () => {
    // `exists: false` with a stored path is the case this field exists for. A
    // plain cd would fail with "no such directory", which tells the user
    // nothing about what to do.
    const get = getReturning({ path: '/tmp/wt/gone', branchName: 'feat/x', exists: false });
    const post = postOk({ path: '/tmp/wt/gone', branchName: 'feat/x' });
    const result = await resolveWorktree('i1', { port: PORT, get, post });
    expect(post).toHaveBeenCalledOnce();
    expect(result.cwd).toBe('/tmp/wt/gone');
  });

  it('creates a worktree for an item that never had one', async () => {
    // ensureWorktreeForItem only fires when the project has autoWorktree AND
    // projectRoot, and it swallows its own errors with a warn — so an item
    // having no worktree is ordinary, not exceptional.
    const get = getReturning({ path: null, branchName: null, exists: false });
    const post = postOk({ path: '/tmp/wt/new', branchName: 'feat/new' });
    const result = await resolveWorktree('i1', { port: PORT, get, post });
    expect(post).toHaveBeenCalledOnce();
    expect(result.cwd).toBe('/tmp/wt/new');
  });

  it('refuses rather than falling back when the worktree cannot be made', async () => {
    // The assertion the whole file exists for. A terminal that opens in the
    // wrong directory is worse than one that does not open: the agent runs,
    // commits, and pushes somewhere nobody asked for.
    const get = getReturning({ path: null, branchName: null, exists: false });
    const post = vi.fn(async () => ({ status: 400, body: '{"error":"project has no projectRoot"}', contentType: 'application/json' }));
    await expect(resolveWorktree('i1', { port: PORT, get, post })).rejects.toThrow(/worktree/i);
  });

  it('never resolves to the process working directory', async () => {
    // Stated as its own test because it is the specific shape of BUG b68254ec:
    // under the desktop app process.cwd() is a real directory, so a fallback
    // produces a plausible wrong answer instead of an obvious failure.
    const get = getReturning({ path: null, branchName: null, exists: false });
    const post = vi.fn(async () => ({ status: 500, body: '{}', contentType: 'application/json' }));
    await expect(resolveWorktree('i1', { port: PORT, get, post })).rejects.toThrow();
    // And nothing in the module may quietly produce cwd as a value.
    const failures = await resolveWorktree('i1', { port: PORT, get, post }).catch(e => e);
    expect(String(failures.message)).not.toContain(process.cwd());
  });

  it('refuses an item the server does not know', async () => {
    const get = vi.fn(async () => ({ status: 404, body: '{"error":"Item not found"}', contentType: 'application/json' }));
    const post = vi.fn();
    await expect(resolveWorktree('nope', { port: PORT, get, post })).rejects.toThrow(/not found/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses when the server is unreachable instead of guessing', async () => {
    const get = vi.fn(async () => null);
    const post = vi.fn();
    await expect(resolveWorktree('i1', { port: PORT, get, post })).rejects.toThrow(/server/i);
  });

  it('refuses a non-JSON answer rather than parsing whatever arrived', async () => {
    const get = vi.fn(async () => ({ status: 200, body: '<html>login</html>', contentType: 'text/html' }));
    const post = vi.fn();
    await expect(resolveWorktree('i1', { port: PORT, get, post })).rejects.toThrow();
  });

  it('asks the server for the item it was given, and nothing else', async () => {
    // The renderer supplies the item id, so it is the one piece of caller
    // input on this path. It must land in the URL path, never be able to
    // change which endpoint is called.
    const get = getReturning({ path: '/tmp/wt/x', branchName: 'b', exists: true });
    const post = vi.fn();
    await resolveWorktree('../../admin', { port: PORT, get, post }).catch(() => {});
    const requestedPath = get.mock.calls[0]?.[1] as string;
    expect(requestedPath.startsWith('/items/')).toBe(true);
    expect(requestedPath).not.toContain('../');
  });
});

/*
 * The server's words, kept.
 *
 * Every refusal here arrives as `{ error }`, and the sentence is the whole
 * value: "Project has no projectRoot" and git's "not a git repository" are
 * different problems with different fixes. This used to reduce both to
 * "The server refused to create a worktree for the card (HTTP 400)", which is
 * a number where there was an explanation.
 */
describe('why the server refused', () => {
  const json = (status: number, body: string) =>
    ({ status, contentType: 'application/json', body });

  it('repeats the reason it was given', async () => {
    await expect(resolveWorktree('i1', {
      port: 3000,
      get: async () => json(200, JSON.stringify({ path: null, branchName: null, exists: false })) as never,
      post: async () => json(400, JSON.stringify({
        error: "fatal: not a git repository (or any of the parent directories): .git",
      })) as never,
    })).rejects.toThrow(/not a git repository/);
  });

  it('names the project root case in the server’s own words', async () => {
    await expect(resolveWorktree('i1', {
      port: 3000,
      get: async () => json(400, JSON.stringify({
        error: 'Project has no projectRoot. Set it before creating a worktree.',
      })) as never,
      post: async () => null as never,
    })).rejects.toThrow(/has no projectRoot/);
  });

  it('still says something useful when there is no reason to repeat', async () => {
    // A refusal with an empty or non-JSON body is the case the old message was
    // written for; it keeps it.
    await expect(resolveWorktree('i1', {
      port: 3000,
      get: async () => ({ status: 500, contentType: 'text/plain', body: 'nope' }) as never,
      post: async () => null as never,
    })).rejects.toThrow(/HTTP 500/);
  });
});

/*
 * A project that is not a repository.
 *
 * The app's own default project is a plain folder in Documents, so this was
 * the first thing a new install hit: press Start, get "The server refused to
 * create a worktree for the card (HTTP 400)" — a failure about the card, for a
 * reason that has nothing to do with the card.
 */
describe('projects with no git', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    port: 3000,
    get: vi.fn(async () => { throw new Error('the server should not be asked'); }),
    post: vi.fn(async () => { throw new Error('the server should not be asked'); }),
    isRepo: vi.fn(() => false),
    projectRoot: vi.fn(async () => '/Users/me/Documents/Default Project'),
    ...over,
  });

  it('opens in the project root instead of failing', async () => {
    const d = deps();
    expect(await resolveWorktree('i1', d as never)).toEqual({
      cwd: '/Users/me/Documents/Default Project',
      branchName: null,
    });
    // ASKED ABOUT THE ROOT, not about the item: a fake that answers false to
    // anything let an implementation that asked the wrong question pass.
    expect(d.isRepo).toHaveBeenCalledWith('/Users/me/Documents/Default Project');
  });

  it('leaves a MISSING root to the server, which has a sentence for it', async () => {
    // Opening a pty in a directory that is not there fails with a raw errno,
    // where the server says "Project has no projectRoot" — the sentence this
    // module goes out of its way to carry.
    const d = deps({
      exists: vi.fn(() => false),
      get: vi.fn(async () => ({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'Project has no projectRoot. Set it before creating a worktree.' }),
      })),
    });
    await expect(resolveWorktree('i1', d as never)).rejects.toThrow(/has no projectRoot/);
  });

  it('does not ask the server to cut a worktree it cannot cut', async () => {
    const d = deps();
    await resolveWorktree('i1', d as never);
    expect(d.post).not.toHaveBeenCalled();
  });

  it('answers with no branch, because there is none', async () => {
    // The branch is what the "never fall back" rule protects. With no git
    // there is no branch to be wrong about, and claiming one would be the
    // plausible wrong answer this file exists to refuse.
    const { branchName } = await resolveWorktree('i1', deps() as never);
    expect(branchName).toBeNull();
  });

  it('leaves a real repository on the worktree path', async () => {
    const d = deps({
      isRepo: vi.fn(() => true),
      get: vi.fn(async () => ({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ path: '/wt/card', branchName: 'feat/x', exists: true }),
      })),
    });
    expect(await resolveWorktree('i1', d as never)).toEqual({ cwd: '/wt/card', branchName: 'feat/x' });
  });

  it('keeps the old behaviour when the caller cannot look at the disk', async () => {
    // The browser has no fs. Without these deps nothing changes.
    const d = {
      port: 3000,
      get: vi.fn(async () => ({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ path: '/wt/card', branchName: 'feat/x', exists: true }),
      })),
      post: vi.fn(),
    };
    expect(await resolveWorktree('i1', d as never)).toEqual({ cwd: '/wt/card', branchName: 'feat/x' });
  });
});


/*
 * A repository with nothing to branch from.
 *
 * Reported from the app: pressing a card in a freshly `git init`-ed project
 * answered with git's `--orphan` hint page. `git worktree add` needs a commit
 * to base the new branch on; an unborn HEAD has none.
 */
describe('a repository with no commits yet', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    port: 3000,
    get: vi.fn(async () => { throw new Error('the server should not be asked'); }),
    post: vi.fn(async () => { throw new Error('the server should not be asked'); }),
    isRepo: vi.fn(() => true),
    hasCommits: vi.fn(() => false),
    exists: vi.fn(() => true),
    projectRoot: vi.fn(async () => '/Users/me/agenfk/myles-marketplace-web'),
    ...over,
  });

  it('opens in the project root instead of failing', async () => {
    expect(await resolveWorktree('i1', deps() as never)).toEqual({
      cwd: '/Users/me/agenfk/myles-marketplace-web',
      branchName: null,
    });
  });

  it('does not ask the server for a worktree it cannot cut', async () => {
    const d = deps();
    await resolveWorktree('i1', d as never);
    expect(d.post).not.toHaveBeenCalled();
    expect(d.hasCommits).toHaveBeenCalledWith('/Users/me/agenfk/myles-marketplace-web');
  });

  it('goes back to worktrees as soon as there is a commit', async () => {
    // The first commit made in that root is all it takes; nothing else has to
    // be undone.
    const d = deps({
      hasCommits: vi.fn(() => true),
      get: vi.fn(async () => ({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ path: '/wt/card', branchName: 'feat/x', exists: true }),
      })),
    });
    expect(await resolveWorktree('i1', d as never)).toEqual({ cwd: '/wt/card', branchName: 'feat/x' });
  });
});


/*
 * The race that made the fallback fail exactly when it was needed.
 *
 * The no-git check used to run BEFORE asking the server, and the check needs
 * an HTTP call of its own — so one second after `agenfk restart`, with the
 * server still booting, the lookup answered nothing, the check gave up, and
 * the request went on to fail with a message about git. Asking the server
 * first and softening its refusal afterwards has no such window.
 */
describe('when the project lookup is not answered yet', () => {
  it('falls back once the lookup works, even though it failed the first time', async () => {
    let attempt = 0;
    const d = {
      port: 3000,
      get: vi.fn(async () => ({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'not a git repository: /Users/me/Documents/Default Project' }),
      })),
      post: vi.fn(),
      isRepo: vi.fn(() => false),
      exists: vi.fn(() => true),
      projectRoot: vi.fn(async () => {
        // The first call lands while the server is still coming up.
        attempt += 1;
        return attempt === 1 ? null : '/Users/me/Documents/Default Project';
      }),
    };
    // First attempt: nothing to fall back to, so the server's sentence stands.
    await expect(resolveWorktree('i1', d as never)).rejects.toThrow(/not a git repository/);
    // Second: the same refusal, and now the root can be read.
    expect(await resolveWorktree('i1', d as never)).toEqual({
      cwd: '/Users/me/Documents/Default Project',
      branchName: null,
    });
  });

  it('keeps the server’s words when the root cannot be read at all', async () => {
    const d = {
      port: 3000,
      get: vi.fn(async () => ({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'Project has no projectRoot. Set it before creating a worktree.' }),
      })),
      post: vi.fn(),
      isRepo: vi.fn(() => false),
      exists: vi.fn(() => true),
      projectRoot: vi.fn(async () => { throw new Error('the server is down'); }),
    };
    await expect(resolveWorktree('i1', d as never)).rejects.toThrow(/has no projectRoot/);
  });

  it('does not soften a refusal about a real repository', async () => {
    // A checkout that git recognises and that has commits: whatever went wrong
    // there is not the no-git case, and hiding it in the project root would
    // put an agent on the wrong branch — the thing this module exists for.
    const d = {
      port: 3000,
      get: vi.fn(async () => ({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: 'git worktree add failed: index.lock exists' }),
      })),
      post: vi.fn(),
      isRepo: vi.fn(() => true),
      hasCommits: vi.fn(() => true),
      exists: vi.fn(() => true),
      projectRoot: vi.fn(async () => '/checkout/agenfk'),
    };
    await expect(resolveWorktree('i1', d as never)).rejects.toThrow(/index\.lock/);
  });
});


/*
 * A branch that is already checked out.
 *
 * git allows ONE worktree per branch. Reopening a card whose branch sits in the
 * main clone answered "fatal: 'feat/…' is already used by worktree at
 * /Users/…/myles-marketplace-web" — a refusal that names its own answer: that
 * path is where this card's work is.
 */
describe('a branch already checked out somewhere', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    port: 3000,
    get: vi.fn(async () => ({
      status: 400, contentType: 'application/json',
      body: JSON.stringify({
        error: "git worktree add failed: 'feat/x' is already used by worktree at /checkout/myles",
      }),
    })),
    post: vi.fn(),
    isRepo: vi.fn(() => true),
    hasCommits: vi.fn(() => true),
    exists: vi.fn(() => true),
    projectRoot: vi.fn(async () => '/checkout/myles'),
    itemBranch: vi.fn(async () => 'feat/x'),
    worktreeFor: vi.fn(() => '/checkout/myles'),
    ...over,
  });

  it('opens where the branch is, instead of reporting the refusal', async () => {
    const d = deps();
    expect(await resolveWorktree('i1', d as never)).toEqual({
      cwd: '/checkout/myles',
      branchName: 'feat/x',
    });
    expect(d.worktreeFor).toHaveBeenCalledWith('/checkout/myles', 'feat/x');
  });

  it('keeps the refusal when the branch is out NOWHERE this app can see', async () => {
    // Then the failure is about something else, and inventing a directory is
    // the "plausible wrong answer" this module exists to refuse.
    await expect(resolveWorktree('i1', deps({ worktreeFor: vi.fn(() => null) }) as never))
      .rejects.toThrow(/already used by worktree/);
  });

  it('keeps the refusal when the card has no branch to look for', async () => {
    await expect(resolveWorktree('i1', deps({ itemBranch: vi.fn(async () => null) }) as never))
      .rejects.toThrow(/already used by worktree/);
  });

  it('never reaches this for a project with no git, which is answered earlier', async () => {
    const d = deps({ isRepo: vi.fn(() => false) });
    expect(await resolveWorktree('i1', d as never)).toEqual({ cwd: '/checkout/myles', branchName: null });
    expect(d.worktreeFor).not.toHaveBeenCalled();
  });
});
