/**
 * Turning a claim into a refusal (819e7192).
 *
 * claims.ts answers whether two paths overlap, and nothing asks it. It has
 * been complete and unreachable since it was written: the gatekeeper does not
 * consult it, dispatch does not consult it, and closeCommit takes claims
 * through a parameter no caller passes. This is the layer that closes that.
 *
 * TWO FAILURES, IN OPPOSITE DIRECTIONS, AND BOTH ARE EASY HERE.
 *
 * Blocking everything is the first. Every card in the database predates this
 * field, so a gate that reads absence as conflict refuses the first edit
 * anybody makes after it ships. Absence authorizes.
 *
 * Failing open is the second, and it is the one claims.ts had four times over.
 * A claim this cannot parse is not a claim it has cleared: the card that wrote
 * `packages/**` believes it holds that subtree and holds nothing at all.
 * Reporting that as authorization tells it the opposite of the truth.
 *
 * Pure, like claims.ts, and for the same reason: the server, the CLI and the
 * MCP tool must reach the same verdict, and three copies would drift the way
 * the gatekeeper's hardcoded status names drifted before it.
 */

import { findClaimConflicts, type Claim, type ClaimConflict } from './claims';

export interface ClaimHolder {
  readonly id: string;
  /** Where the card sits in its flow. Decides whether it still holds files. */
  readonly status: string;
  readonly claims?: readonly Claim[];
  /**
   * The tree this card actually works in. Only cards sharing it can collide —
   * see `gateOnClaims`.
   */
  readonly scope?: string;
}

export interface ScopeItem {
  readonly id: string;
  readonly projectId?: string | null;
  readonly parentId?: string | null;
  readonly worktreePath?: string | null;
}

/**
 * The tree each item works in, as a comparable key.
 *
 * A child shares its nearest ancestor's worktree (`shouldAutoWorktree` refuses
 * a child its own), so the key is the effective worktree: the item's own path,
 * else the parent's, recursively — else the PROJECT, which is one shared tree
 * for every card that has no worktree of its own.
 *
 * Pure, and here rather than in the server, because the CLI's gatekeeper and
 * the server's declaration route must reach the SAME key or the two gates
 * disagree — one refusing what the other allows.
 */
export function claimScopes(items: readonly ScopeItem[]): Map<string, string> {
  const byId = new Map(items.map(i => [i.id, i]));
  const memo = new Map<string, string>();
  const visiting = new Set<string>();
  const resolve = (id: string): string => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const it = byId.get(id);
    const fallback = `project:${it?.projectId ?? ''}`;
    // A parent cycle must not hang the gate; the fallback is the conservative
    // answer (same project = same tree = contend).
    if (!it || visiting.has(id)) return fallback;
    visiting.add(id);
    // Normalised, so `/wt` and `/wt/` are one key rather than two trees.
    const wt = typeof it.worktreePath === 'string' ? normaliseTree(it.worktreePath) : '';
    const key = wt || (it.parentId && byId.has(it.parentId) ? resolve(it.parentId) : fallback);
    visiting.delete(id);
    memo.set(id, key);
    return key;
  };
  const out = new Map<string, string>();
  for (const i of items) out.set(i.id, resolve(i.id));
  return out;
}

/** One spelling of a tree path, so two habits cannot invent two trees. */
const normaliseTree = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Is this a path that names a filesystem root, on ANY platform?
 *
 * `startsWith('/')` is a Unix-only test: on Windows every worktree is
 * `C:\…`, so every scope was skipped and every agent fell back to the project
 * — the isolation vanished exactly where it was needed.
 */
const isAbsoluteTree = (p: string): boolean => /^([A-Za-z]:)?\//.test(p) || /^\/\//.test(p);

/**
 * The tree the caller is ACTUALLY in, from its working directory.
 *
 * The declared worktree is not enough on its own. Nothing stops an agent whose
 * card carries a worktree from editing the MAIN checkout — and scoping the
 * gate by the DECLARED tree then authorizes it alongside a main-tree card, so
 * the silent overwrite the mechanism exists to prevent comes back. The edit
 * happens in the directory the caller is standing in, so that is the tree the
 * gate has to compare against.
 *
 * The LONGEST containing worktree wins, so a nested checkout resolves to the
 * inner one; a directory in no worktree is the project's own tree, which is
 * exactly the `project:<id>` scope `claimScopes` gives to cards without one.
 *
 * A LIMIT, stated because it matters: `cwd` is where the PROCESS is, not the
 * file about to be written. An agent standing in its worktree that writes an
 * absolute path into the main checkout is not caught here — only the edit hook,
 * which sees the file, can catch that.
 */
export function scopeAt(
  cwd: string,
  items: readonly ScopeItem[],
  projectId?: string | null,
): string {
  const scopes = claimScopes(items);
  const here = normaliseTree(cwd);
  let best: string | undefined;
  for (const scope of new Set(scopes.values())) {
    if (!isAbsoluteTree(scope)) continue;
    const tree = normaliseTree(scope);
    if (here === tree || here.startsWith(tree + '/')) {
      if (best === undefined || tree.length > normaliseTree(best).length) best = scope;
    }
  }
  return best ?? `project:${projectId ?? ''}`;
}

export interface ClaimGateResult {
  readonly authorized: boolean;
  readonly conflicts: readonly ClaimConflict[];
  /** Claims that could not be checked, and therefore have NOT been cleared. */
  readonly rejected: readonly Claim[];
  /** What to tell the agent. Empty when authorized. */
  readonly message: string;
}

/**
 * Statuses where a card has stopped holding its files.
 *
 * DELIBERATELY NOT `INACTIVE_STATUSES` from gatekeeper.ts, and reusing it is
 * the obvious mistake to make here. That set answers "is this card working",
 * which includes PAUSED and BLOCKED. This one answers "are this card's files
 * finished with", and a paused card's files are the opposite of finished: they
 * are half-edited and lying in the shared tree. Handing them to another agent
 * is exactly the race this mechanism exists to prevent, and the paused agent
 * meets it on resume, which is the worst possible moment to find out.
 *
 * A terminal card is different. Its work is committed or abandoned, so holding
 * the files forever would make the first fan-out permanent. IDEAS is here
 * because an idea has never been worked and has nothing in the tree.
 */
const RELEASED_STATUSES = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

/** Does this card still own the files it declared? */
export const stillHolds = (status: string): boolean =>
  !RELEASED_STATUSES.has(status.toUpperCase());

/**
 * What to say, given that the agent reads this once and acts on it.
 *
 * It names the file and the holder because "claim conflict" produces a retry,
 * and a retry produces the overwrite. It offers no retry of its own: there is
 * nothing to wait for, since the holder is not going to release mid-edit.
 */
function explain(conflicts: readonly ClaimConflict[], rejected: readonly Claim[]): string {
  const parts: string[] = [];
  if (conflicts.length) {
    const lines = conflicts.map(c =>
      // "X is inside X" is what an exact collision used to read as, which is
      // nonsense at the moment somebody most needs the sentence to be clear.
      c.wanted === c.held
        ? `  ${c.wanted} is already held by ${c.heldBy}`
        : `  ${c.wanted} is inside ${c.held}, held by ${c.heldBy}`);
    parts.push(
      `This card claims ${conflicts.length === 1 ? 'a path' : 'paths'} another card already owns:\n`
      + lines.join('\n')
      + '\nSeveral agents share this worktree, so two cards editing one file is a silent '
      + 'overwrite rather than a merge conflict. Narrow this card\'s claim, or move the work '
      + 'to the card that holds it.',
    );
  }
  if (rejected.length) {
    parts.push(
      `These claims could not be checked, so they have NOT been cleared: ${rejected.join(', ')}. `
      + 'A claim is a directory or an exact file. Globs are refused rather than approximated, '
      + 'because a claim on a file named `**` protects nothing while looking like it protects '
      + 'everything.',
    );
  }
  return parts.join('\n\n');
}

/**
 * May this card edit the paths it claims?
 *
 * Returns every conflict rather than the first: a lead re-cutting a fan-out
 * needs the whole picture, and one collision at a time turns a single decision
 * into a sequence of them, each invalidating the last.
 */
export function gateOnClaims(
  asking: {
    readonly id: string;
    readonly claims?: readonly Claim[];
    /** The tree its card DECLARES. */
    readonly scope?: string;
    /** The tree the caller is standing in, when we know it. */
    readonly cwdScope?: string;
  },
  holders: readonly ClaimHolder[],
): ClaimGateResult {
  const wanted = asking.claims ?? [];
  // Absence authorizes. See the header: this is the state every card is in
  // today, and the alternative is refusing all work on the deploy that adds it.
  if (!wanted.length) {
    return { authorized: true, conflicts: [], rejected: [], message: '' };
  }

  /*
   * A UNION, not a swap.
   *
   * Scoping by the declared tree alone missed an agent editing the main
   * checkout; scoping by `cwd` alone missed one who edits its own worktree by
   * ABSOLUTE path from a shell that sits in the repo root — both ordinary. The
   * agent may be in either tree, so it has to contend with the holders of
   * both. An empty set means neither tree is known, and then everything
   * contends.
   */
  const askingScopes = new Set(
    [asking.scope, asking.cwdScope].filter((s): s is string => s !== undefined),
  );
  const held = holders
    .filter(h => stillHolds(h.status))
    .filter(h => askingScopes.size === 0 || h.scope === undefined || askingScopes.has(h.scope))
    .map(h => ({ itemId: h.id, claims: h.claims }));

  const { conflicts, rejected } = findClaimConflicts(wanted, held, asking.id);
  const authorized = conflicts.length === 0 && rejected.length === 0;

  return {
    authorized,
    conflicts,
    rejected,
    message: authorized ? '' : explain(conflicts, rejected),
  };
}
