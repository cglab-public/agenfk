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
