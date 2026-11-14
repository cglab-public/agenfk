/**
 * Where a card's terminal opens (CGLAB-169).
 *
 * The feature is "one terminal per card, in that card's own worktree". A
 * directory resolved by guess or by fallback turns that into "a terminal
 * somewhere", and the agent then commits and pushes on the wrong branch. So
 * every failure on this path throws rather than substituting something
 * plausible.
 *
 * The git plumbing already exists — CGLAB-166 built `POST/GET/DELETE
 * /items/:id/worktree` and `ensureWorktreeForItem`. This module only decides
 * which of those to call; it never runs git itself.
 *
 * `exists` is the field that matters. The server returns it specifically so a
 * caller can tell "never created" from "created, then deleted by hand": the
 * second is a stored path that no longer resolves, and a plain cd into it
 * fails with a message about a missing directory rather than about a worktree
 * that needs recreating.
 */
import type { HttpResponse } from './probes.js';

export interface WorktreeDeps {
  readonly port: number;
  readonly get: (port: number, path: string, headers?: Record<string, string>) => Promise<HttpResponse | null>;
  readonly post: (port: number, path: string, headers?: Record<string, string>) => Promise<HttpResponse | null>;
  /**
   * Is this directory a git checkout? Asked before a worktree is attempted.
   *
   * A project can be an ordinary folder — the default one this app creates is
   * exactly that — and `git worktree add` has nothing to add to it.
   *
   * IT MUST ASK GIT, not look for `.git`. A folder nested inside a repository
   * has no `.git` of its own and is still a checkout — `packages/ui` in this
   * very repo — and answering "no" there opens the card's terminal in the
   * project root, on whatever branch the person happens to have out, with no
   * worktree at all. That is the failure this module exists to prevent, and it
   * would have been caused by the guard meant to soften it. `git rev-parse
   * --git-dir` is the same question the server asks (server/worktrees.ts).
   *
   * Optional so callers that cannot look at the disk keep the old behaviour.
   */
  readonly isRepo?: (dir: string) => boolean;
  /** Where the project lives, for the case above. */
  readonly projectRoot?: (itemId: string) => Promise<string | null>;
  /** Whether that directory is there at all. Absent means "do not check". */
  readonly exists?: (dir: string) => boolean;
  /**
   * Where a branch is ALREADY checked out, if it is.
   *
   * git allows one worktree per branch, so a card whose branch is checked out
   * in the main clone — or in a worktree somebody cut by hand — cannot get a
   * second one. That is not a failure to report: the work for that branch is
   * in that directory, and it is the directory this card means.
   */
  readonly worktreeFor?: (root: string, branch: string) => string | null;
  /** The card's branch, for the lookup above. */
  readonly itemBranch?: (itemId: string) => Promise<string | null>;
  /**
   * Whether the repository has a commit yet.
   *
   * `git worktree add` needs something to base the new branch on, and a fresh
   * `git init` has an UNBORN HEAD — a ref that names a branch with no commits.
   * git's own answer to this is a page of hints about `--orphan`, which is a
   * true answer to a question nobody asked: the person pressed a button on a
   * card. Absent means "do not check".
   */
  readonly hasCommits?: (dir: string) => boolean;
}

export interface ResolvedWorktree {
  /** Absolute directory to open the PTY in. Never a fallback. */
  readonly cwd: string;
  readonly branchName: string | null;
}

interface WorktreeAnswer {
  path: string | null;
  branchName: string | null;
  exists: boolean;
}

/**
 * The server's own sentence, when it sent one.
 *
 * Every refusal on this path arrives as `{ error: "<why>" }`, and that text is
 * the only part worth reading: "Project has no projectRoot" and git's own
 * "not a git repository" are different problems with different fixes. Reducing
 * both to "HTTP 400" hands the person a number and sends them to the logs.
 */
function reasonFrom(res: HttpResponse): string | null {
  if (!res.contentType.includes('json')) return null;
  try {
    const said = (JSON.parse(res.body) as { error?: unknown })?.error;
    return typeof said === 'string' && said.trim() ? said.trim() : null;
  } catch {
    return null;
  }
}

function parseJson(res: HttpResponse | null, what: string): unknown {
  if (!res) throw new Error(`Could not reach the AgEnFK server to ${what}.`);
  if (res.status === 404) throw new Error(`Item not found while trying to ${what}.`);
  if (res.status >= 400) {
    const why = reasonFrom(res);
    throw new Error(why
      ? `Could not ${what}: ${why}`
      : `The server refused to ${what} (HTTP ${res.status}).`);
  }
  if (!res.contentType.includes('json')) {
    throw new Error(`Expected JSON while trying to ${what}, got ${res.contentType || 'no content type'}.`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`The server returned malformed JSON while trying to ${what}.`);
  }
}

/**
 * Resolve — and if necessary create — the worktree a card's terminal opens in.
 *
 * Throws on every path that cannot produce a real directory for this item.
 * Deliberately never falls back to `process.cwd()`: under the desktop app that
 * is a real directory (the server is forked with cwd=packages/server/dist), so
 * a fallback would produce a plausible wrong answer rather than an obvious
 * failure. That is the exact shape of BUG b68254ec.
 */
export async function resolveWorktree(itemId: string, deps: WorktreeDeps): Promise<ResolvedWorktree> {
  try {
    return await fromServer(itemId, deps);
  } catch (e) {
    /*
     * THE SERVER DECIDES FIRST, and only then do we soften its refusal.
     *
     * This check used to run BEFORE asking, and that made it a race: the
     * lookup it needs is itself an HTTP call, so a server still booting — the
     * ordinary case one second after `agenfk restart` — answered nothing, the
     * check gave up, and the request went on to fail for a reason about git.
     *
     * Asking afterwards has no such window. A refusal is already in hand, the
     * root can be looked up at leisure, and if THAT fails the server's own
     * sentence is what the person sees.
     */
    const root = deps.projectRoot ? await deps.projectRoot(itemId).catch(() => null) : null;
    if (!root || !deps.isRepo || deps.exists?.(root) === false) throw e;
    /*
     * Not a repository, or a repository with nothing to branch FROM. Both open
     * in the project root, for the same reason: there is no branch to be wrong
     * about. The first commit made there turns the next card's terminal into
     * an ordinary worktree, with nothing to undo.
     */
    if (!deps.isRepo(root) || deps.hasCommits?.(root) === false) {
      return { cwd: root, branchName: null };
    }
    /*
     * THE BRANCH IS ALREADY OUT SOMEWHERE, which is git's own rule rather than
     * a fault: one worktree per branch. Reopening a card whose branch sits in
     * the main clone answers "already used by worktree at <path>" — a refusal
     * that names its own answer, because that path IS this card's directory.
     */
    if (deps.worktreeFor && deps.itemBranch) {
      const branch = await deps.itemBranch(itemId).catch(() => null);
      const held = branch ? deps.worktreeFor(root, branch) : null;
      if (branch && held) return { cwd: held, branchName: branch };
    }
    throw e;
  }
}

async function fromServer(itemId: string, deps: WorktreeDeps): Promise<ResolvedWorktree> {
  /*
   * NOT EVERY PROJECT IS A REPOSITORY, and that is not a failure.
   *
   * A folder with no `.git` cannot have a worktree cut from it: git refuses,
   * the server answers 400, and the person is told their card could not start
   * — for a reason that has nothing to do with the card. The app's own default
   * project is such a folder, so this was the first thing a new install hit.
   *
   * Opening in the project root is not the "plausible wrong answer" this file
   * refuses elsewhere. That rule protects the BRANCH: a guessed directory
   * means an agent committing on somebody else's. Here there is no branch to
   * be wrong about — there is no git at all — and the root is the only
   * directory this card could ever mean.
   */
  // The item id is the renderer's only input on this path. encodeURIComponent
  // keeps it a single path segment, so it can never change which endpoint is
  // called — only which item is asked about.
  const itemPath = `/items/${encodeURIComponent(itemId)}/worktree`;

  const current = parseJson(await deps.get(deps.port, itemPath), 'look up the card\'s worktree') as WorktreeAnswer;

  if (current.path && current.exists) {
    return { cwd: current.path, branchName: current.branchName ?? null };
  }

  // Either never created, or created and since deleted. Both are ordinary:
  // ensureWorktreeForItem only fires when the project has autoWorktree AND
  // projectRoot, and it swallows its own errors with a warn.
  const created = parseJson(
    await deps.post(deps.port, itemPath),
    'create a worktree for the card',
  ) as { path?: string | null; branchName?: string | null };

  if (!created?.path) {
    throw new Error(
      'The server did not return a worktree path for this card. '
      + 'Check that the project has a project root configured.',
    );
  }

  return { cwd: created.path, branchName: created.branchName ?? null };
}
