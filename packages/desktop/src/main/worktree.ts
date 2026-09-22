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
  if (deps.isRepo && deps.projectRoot) {
    const root = await deps.projectRoot(itemId);
    /*
     * A root that is not there is NOT the no-git case: opening a pty in a
     * missing directory fails with a raw errno, where the server would have
     * said "Project has no projectRoot" — the sentence `reasonFrom` exists to
     * preserve. Anything but a directory git recognises falls through to the
     * server, which is the side that decides.
     */
    if (root && deps.exists?.(root) !== false && !deps.isRepo(root)) {
      return { cwd: root, branchName: null };
    }
  }

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
