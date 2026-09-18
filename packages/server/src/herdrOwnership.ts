/**
 * Who a herdr pane belongs to (96953f6a / CGLAB-266).
 *
 * TWO POPULATIONS SHARE ONE LIST and the whole point of this file is not to
 * confuse them:
 *
 *   • Sessions AgEnFK itself started. Their cwd sits inside a worktree a card
 *     owns, so the row can carry the card's name, its step and its branch.
 *   • Everything else the developer is running. Those work in their own cwd,
 *     need no worktree — they already have a place — and must NOT be handed a
 *     card they do not have.
 *
 * Measured when this was written: of eight directories across the live panes on
 * this machine, ZERO fell inside an AgEnFK worktree. That is not a reason to
 * skip the mapping; it is the state before AgEnFK launches anything into herdr.
 * The moment it does, those panes arrive with a card and this answers with it.
 *
 * PATH CONTAINMENT DECIDES, NEVER A TITLE. A live pane's title read
 * "Implementar fault tolerance no LiteLLM" — indistinguishable from a card, and
 * it was another agent typing. Matching on that would invent an association
 * that nobody asked for and nobody could correct.
 */
import path from 'path';

export interface OwnerCard {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly branchName?: string;
  readonly worktreePath?: string;
  readonly projectId?: string;
}

export interface OwnerProject {
  readonly id: string;
  readonly name: string;
  readonly projectRoot?: string;
}

export interface OwnerInputs {
  readonly cards: readonly OwnerCard[];
  readonly projects: readonly OwnerProject[];
}

export type PaneOwner =
  | { readonly kind: 'card'; readonly card: OwnerCard; readonly project?: OwnerProject }
  | { readonly kind: 'project'; readonly project: OwnerProject }
  /** Not ours, and that is a first-class answer rather than a gap. */
  | { readonly kind: 'external' };

/**
 * Whether `child` is `base` or sits inside it.
 *
 * SEGMENTS, NOT CHARACTERS. `/wt/feat-x-old` starts with `/wt/feat-x` and is a
 * different tree — this repository has already shipped one containment guard
 * that got this wrong, and it refused 0 of 40 hostile pairs before anyone
 * noticed. An empty base is refused outright: `''` is a prefix of everything,
 * which would quietly make one card the owner of every pane on the machine.
 */
function contains(base: string | undefined, child: string): boolean {
  const b = base?.trim();
  if (!b || !child) return false;
  const nb = path.resolve(b);
  const nc = path.resolve(child);
  return nc === nb || nc.startsWith(nb + path.sep);
}

/**
 * The card or project a pane's directory falls under.
 *
 * THE DEEPEST MATCH WINS. A card cut from another card's tree is legal, and the
 * inner one is the specific answer; the outer would be true but useless.
 */
export function ownerOfPane(cwd: string | undefined, inputs: OwnerInputs): PaneOwner {
  // No early return for an empty cwd: `contains` refuses an empty child, so
  // nothing matches and the fall-through already answers `external`. A guard
  // that cannot change the answer is a line nobody can test.
  const dir = (cwd ?? '').trim();

  let best: OwnerCard | null = null;
  for (const card of inputs.cards) {
    if (!contains(card.worktreePath, dir)) continue;
    const better = best === null
      || (card.worktreePath ?? '').length > (best.worktreePath ?? '').length;
    if (better) best = card;
  }
  if (best) {
    const project = inputs.projects.find(p => p.id === best?.projectId);
    return project ? { kind: 'card', card: best, project } : { kind: 'card', card: best };
  }

  let bestProject: OwnerProject | null = null;
  for (const project of inputs.projects) {
    if (!contains(project.projectRoot, dir)) continue;
    const better = bestProject === null
      || (project.projectRoot ?? '').length > (bestProject.projectRoot ?? '').length;
    if (better) bestProject = project;
  }
  if (bestProject) return { kind: 'project', project: bestProject };

  return { kind: 'external' };
}
