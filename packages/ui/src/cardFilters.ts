/**
 * What the project page's Cards tab shows, and what each row offers.
 *
 * Kept apart from the component because these are the answers that went
 * wrong: a DONE card offered Start, and hiding the finished rows took a menu
 * that could show one state at a time. Every answer is read off the project's
 * own flow — a TDD project's states are not the default flow's, and its exit
 * need not be called DONE.
 */

export interface FlowStepLike {
  readonly name: string;
  readonly order: number;
  readonly isSpecial?: boolean;
  readonly isAnchor?: boolean;
}

export interface FlowLike {
  readonly steps: readonly FlowStepLike[];
}

type MaybeFlow = FlowLike | null | undefined;

/** Out of the flow and out of play: nothing is left to do on them. */
const ALWAYS_FINISHED = ['DONE', 'ARCHIVED', 'TRASHED'];
/**
 * Waiting for somebody to pick them up. IDEAS included, unlike the server's
 * close rule (finishedStatusesOf), where an idea counts as out of play: an
 * idea does not hold its parent's close, but it is not finished - it is work
 * nobody has started, so it shows under Open and offers Start.
 */
const ALWAYS_BACKLOG = ['TODO', 'IDEAS'];

const sortedSteps = (flow: MaybeFlow): FlowStepLike[] =>
  [...(flow?.steps ?? [])].sort((a, b) => a.order - b.order);

const isBoundary = (step: FlowStepLike | undefined): step is FlowStepLike =>
  Boolean(step && (step.isSpecial || step.isAnchor));

/**
 * The states a card has nothing left to do in.
 *
 * The flow's LAST step counts only when it is a boundary — the rule the server
 * closes cards by (finishedStatusesOf): a flow that ends on a working step
 * still has cards working there.
 */
export function finishedStates(flow: MaybeFlow): Set<string> {
  const steps = sortedSteps(flow);
  const finished = new Set(ALWAYS_FINISHED);
  const last = steps[steps.length - 1];
  if (isBoundary(last)) finished.add(last.name);
  return finished;
}

/** The states a card waits in before anyone has worked it. */
export function backlogStates(flow: MaybeFlow): Set<string> {
  const steps = sortedSteps(flow);
  const backlog = new Set(ALWAYS_BACKLOG);
  if (steps.length > 1 && isBoundary(steps[0])) backlog.add(steps[0].name);
  return backlog;
}

/**
 * Every state there is a chip for: the flow's steps that hold a card, in the
 * flow's order — then whatever else the cards are in (PAUSED, BLOCKED, a step
 * of a flow the project no longer runs), so that no card sits in a state
 * nobody can select. Those follow alphabetically, finished ones last.
 */
export function presentStates(flow: MaybeFlow, cards: readonly { status: unknown }[]): string[] {
  const held = new Set(cards.map(c => String(c.status)));
  const inFlow = sortedSteps(flow).map(s => s.name).filter(name => held.has(name));
  const finished = finishedStates(flow);
  const rest = [...held]
    .filter(s => !inFlow.includes(s))
    .sort((a, b) => Number(finished.has(a)) - Number(finished.has(b)) || a.localeCompare(b));
  return [...inFlow, ...rest];
}

export type Preset = 'open' | 'inflight' | 'done' | 'all';

export const PRESETS: readonly { readonly id: Preset; readonly label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'inflight', label: 'In flight' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

/** The states a preset stands for, on this flow and among these states. */
export function presetStates(preset: Preset, states: readonly string[], flow: MaybeFlow): string[] {
  const finished = finishedStates(flow);
  const backlog = backlogStates(flow);
  switch (preset) {
    case 'open': return states.filter(s => !finished.has(s));
    case 'inflight': return states.filter(s => !finished.has(s) && !backlog.has(s));
    case 'done': return states.filter(s => finished.has(s));
    case 'all': return [...states];
  }
}

/**
 * What is selected: a preset — re-read against the cards on every render, so
 * a card reaching a state for the first time shows under Open instead of being
 * hidden by a list taken before that state existed — or a hand-picked set.
 */
export type Selection = { readonly preset: Preset } | { readonly states: readonly string[] };

export function selectedStates(sel: Selection, states: readonly string[], flow: MaybeFlow): Set<string> {
  return new Set('preset' in sel ? presetStates(sel.preset, states, flow) : sel.states);
}

/**
 * What a row's button does.
 *
 * `done` has no button at all: a finished card has nothing to start, and a
 * terminal still open on it is a door to work the row itself already opens.
 */
export type RowAction = 'done' | 'open' | 'elsewhere' | 'start' | 'resume';

export function rowAction(status: unknown, on: 'ours' | 'elsewhere' | undefined, flow: MaybeFlow): RowAction {
  const s = String(status);
  if (finishedStates(flow).has(s)) return 'done';
  if (on === 'ours') return 'open';
  if (on === 'elsewhere') return 'elsewhere';
  return backlogStates(flow).has(s) ? 'start' : 'resume';
}

/**
 * The search: the title, whatever the case, or the START of the id — which is
 * how cards are named in chat ("8024f6c4"), and only the start, because a
 * match in the middle of a uuid is noise.
 */
export function matchesQuery(card: { readonly id: string; readonly title: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return card.title.toLowerCase().includes(q) || card.id.toLowerCase().startsWith(q);
}

/**
 * When a card reached the state it is in: the last move INTO it, from the
 * card's own history. Not `updatedAt`, which every edit moves - a card closed
 * a week ago and renamed today read "Done just now". Null when the history
 * does not say: an unknown time is left out rather than guessed.
 */
export function closedAt(card: {
  readonly status: unknown;
  readonly history?: readonly { readonly toStatus: unknown; readonly timestamp: string }[];
}): string | null {
  const into = (card.history ?? []).filter(h => String(h.toStatus) === String(card.status));
  return into.length ? into[into.length - 1].timestamp : null;
}

/** "5d ago", for when a finished card closed. Coarse on purpose. */
export function ago(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  // Never "in the future": another machine's clock a few seconds ahead.
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}
