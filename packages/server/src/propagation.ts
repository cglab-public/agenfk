/**
 * Whether a sibling's green run still speaks for this card.
 *
 * With several agents in ONE tree - the design, not an accident - a sibling's
 * suite passed against a tree that other agents may have edited since, and the
 * old propagation spent that green as proof. The match was parentId plus the
 * command string and nothing else, which closed 63 of 78 DONE items in this
 * repository without running anything (81%). SDLC.md states the precondition
 * ("same branch/workspace"); SKILL.md drops it and calls the mechanism "costs
 * nothing"; no code checked it.
 *
 * A CLAIM NEEDS A SHA. The sibling's test records the commit it passed at, and
 * propagation stands only while the tree is still there. A record with no SHA
 * - every card that predates this - cannot establish it, so it does not
 * propagate: the honest direction is to RUN the command, not to claim it.
 *
 * The SHA is HEAD, so an edit that was never committed does not move it. That
 * is deliberate and matches the artifact's fix: the close-commit model makes a
 * commit the unit of "what landed", and a dirty tree shared by several agents
 * is exactly the state this cannot speak about. The generous reading is
 * bounded by the fact that falling through costs a command run, never a wrong
 * claim.
 */

export interface TreeShaDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: readonly string[]) => string;
}

/**
 * The commit this tree is at, or null when git cannot say.
 *
 * Never throws: this runs on the validate path, and a repository we cannot
 * read must not become a failed verify. Null means "cannot say", which
 * `mayPropagate` treats as a refusal to propagate - not as current.
 */
/**
 * The working tree's porcelain status, trimmed, or '' when git cannot say.
 *
 * Used to catch an edit that lands DURING a run: a commit moves HEAD, but a
 * staged edit does not, and our own close commit would then sweep it into the
 * recorded commit - a green stamped on content it never ran against.
 */
export function readTreeStatus(repoRoot: string, deps: TreeShaDeps): string {
  try {
    // Porcelain is a PATH-AND-STATE signal, so re-staging the SAME path with
    // different content is byte-identical. `diff --cached --raw` carries the
    // staged blob SHA, which is not - so the pair catches a restage the
    // porcelain alone would miss.
    const porcelain = deps.run(['-C', repoRoot, 'status', '--porcelain']).trim();
    const staged = deps.run(['-C', repoRoot, 'diff', '--cached', '--raw']).trim();
    return `${porcelain}\n${staged}`;
  } catch {
    return '';
  }
}

/** The commit this tree is at, or null. Raw HEAD, no cleanliness claim. */
export function readHead(repoRoot: string, deps: TreeShaDeps): string | null {
  try {
    const sha = deps.run(['-C', repoRoot, 'rev-parse', 'HEAD']).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * The commit a green can honestly be tied to: HEAD of a CLEAN tree, else null.
 *
 * A DIRTY TREE IS "CANNOT SAY". In the one-tree model agents edit WITHOUT
 * committing until close, so a sibling's green at HEAD X says nothing about a
 * tree that has since gained uncommitted work - same commit, later content,
 * which is the exact case this gate exists for. And a card with its own
 * uncommitted work must run its own command anyway: its edits were never
 * covered by the sibling.
 *
 * Refusing is the honest direction: the card runs its command, which is cheap,
 * where propagating would be a claim nothing backs.
 */
export function readCleanTreeSha(repoRoot: string, deps: TreeShaDeps): string | null {
  try {
    if (deps.run(['-C', repoRoot, 'status', '--porcelain']).trim()) return null;
    const sha = deps.run(['-C', repoRoot, 'rev-parse', 'HEAD']).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export interface PropagationDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/** May this card inherit the sibling's green, or does it have to run its own? */
export function mayPropagate(
  currentSha: string | null,
  siblingTest: { readonly commit?: string } | undefined,
): PropagationDecision {
  if (!siblingTest?.commit) {
    return {
      allowed: false,
      reason: 'the sibling recorded no commit, so its green cannot be tied to this tree',
    };
  }
  if (!currentSha) {
    return {
      allowed: false,
      reason: 'this tree has no commit to compare against the sibling green',
    };
  }
  if (currentSha !== siblingTest.commit) {
    return {
      allowed: false,
      reason: `the tree moved since the sibling verified (${siblingTest.commit.slice(0, 8)} -> ${currentSha.slice(0, 8)})`,
    };
  }
  return { allowed: true, reason: null };
}
