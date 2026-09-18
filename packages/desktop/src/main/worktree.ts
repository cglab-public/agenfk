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

function parseJson(res: HttpResponse | null, what: string): unknown {
  if (!res) throw new Error(`Could not reach the AgEnFK server to ${what}.`);
  if (res.status === 404) throw new Error(`Item not found while trying to ${what}.`);
  if (res.status >= 400) throw new Error(`The server refused to ${what} (HTTP ${res.status}).`);
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
