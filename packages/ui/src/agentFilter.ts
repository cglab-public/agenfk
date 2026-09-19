/**
 * Filtering the tree by which agent is running (96953f6a / CGLAB-266).
 *
 * The sidebar could already be SORTED and not narrowed, which stops helping at
 * the size this tree actually reaches - one project here holds twenty-nine
 * cards and four agents, and the question a person arrives with is usually
 * "where is pi running", not "what happened most recently".
 *
 * THE IDS DO NOT AGREE, and that is half the substance of this file. herdr
 * reports `claude` and this app spawns `claude-code`; both are Claude, and
 * filtering on the raw strings would put two entries called Claude in the menu,
 * each hiding half the answer. So the ids are canonicalised first.
 *
 * AND herdr IS NOT AN AGENT. It is a SOURCE - a multiplexer holding somebody
 * else's agents - and its panes report `claude` and `pi`, never `herdr`. The
 * first version of this file treated it as one more agent id, so the herdr row
 * only appeared when an attached terminal happened to be open, and choosing it
 * hid everything. A row therefore carries TAGS, not an id: a pi pane inside
 * herdr answers to Pi and to herdr both, which is what "show me what herdr is
 * holding" has to mean.
 */
import { HERDR_AGENT_ID } from './herdrTreeRows';
import { agentLabel } from './agentLabels';

/**
 * One name per agent, whoever reported it.
 *
 * A closed map rather than prefix matching: `claude-code` and `claude` are the
 * same product, but deciding that by `startsWith` would also fold a future
 * `claude-something-else` into it silently. Anything unrecognised keeps its own
 * id - a new agent under its own name is a cosmetic gap; one folded into the
 * wrong bucket is a wrong answer.
 */
const CANONICAL: Record<string, string> = {
  // herdr says `claude` for what this app spawns as `claude-code`. It folds
  // INTO our id rather than to a shorter one of its own invention, so the name
  // comes from agentLabels - the map that exists because the rail and the
  // picker once disagreed about this exact string.
  claude: 'claude-code',
};

export function canonicalAgent(agentId: string): string {
  const id = agentId.trim().toLowerCase();
  return CANONICAL[id] ?? id;
}

/**
 * The tag that means "this came from herdr", whatever is running inside it.
 *
 * Shares the attach's agent id on purpose: an attached terminal and the panes
 * it is a view onto are the same answer to "what is in herdr", and two tags
 * would split that answer in the menu.
 */
export const HERDR_SOURCE_TAG = HERDR_AGENT_ID;

/** What one row answers to. */
export interface FilterableRow {
  readonly agentId: string;
  /** True for anything herdr is holding, whatever agent is inside it. */
  readonly fromHerdr?: boolean;
}

/**
 * Every name a row can be found under.
 *
 * The attach itself gets ONLY the herdr tag - its "agent" is the multiplexer,
 * and listing it under an agent name would claim a Claude or a Pi that this
 * row is not.
 */
export function agentTags(row: FilterableRow): string[] {
  const id = canonicalAgent(row.agentId);
  const tags = id ? [id] : [];
  if (row.fromHerdr) tags.push(HERDR_SOURCE_TAG);
  /*
   * Deduped, which is not decoration: the ATTACH is a row whose agent id IS
   * the herdr tag, and it also comes from herdr, so it earns the same tag
   * twice. Left doubled it would count itself twice in the menu, and "herdr
   * 3" for two panes is a number somebody would try to reconcile.
   *
   * An early return for that case was here first. It was dead - the id alone
   * already produced the right single tag - and a mutation proved it by
   * surviving its removal.
   */
  return [...new Set(tags)];
}

export interface AgentFilterOption {
  readonly agentId: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The agents actually in the tree, with how many rows each has.
 *
 * PRESENT ONES ONLY. Listing every agent this app supports would put a control
 * in the menu that can only ever empty the list - the product installs five,
 * and a machine rarely runs more than two at once. The count is there so the
 * menu answers the question without being opened twice.
 */
export function availableAgentFilters(
  rows: readonly FilterableRow[],
): AgentFilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    // Counted under EVERY tag it answers to, so herdr's count is "how much
    // herdr is holding" rather than "how many attached terminals are open".
    for (const tag of agentTags(row)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([agentId, count]) => ({ agentId, label: agentLabel(agentId), count }))
    // By name, not by count: a menu whose rows reorder as work starts and stops
    // is one you have to re-read every time you open it.
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Does this agent pass the filter?
 *
 * AN EMPTY SELECTION MEANS EVERYTHING, not nothing. "No filter" and "a filter
 * that excludes all" are the same state in the data and opposite states to a
 * person, and only one of them is a sane thing to land on by unticking the
 * last box.
 */
export function matchesAgentFilter(row: FilterableRow, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  return agentTags(row).some(tag => selected.includes(tag));
}

/**
 * Should this project still be shown?
 *
 * A project with no agent of the chosen kind is hidden entirely. That is the
 * point of the filter - "where is pi running" is answered by a shorter list of
 * projects, not by the same list with emptier branches.
 *
 * A project with NO agents at all is hidden too while a filter is on, for the
 * same reason and no other: it cannot answer the question being asked.
 */
export function projectMatchesAgentFilter(
  rows: readonly FilterableRow[],
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  return rows.some(row => matchesAgentFilter(row, selected));
}

/**
 * Should this card still be shown?
 *
 * The filter has to reach the CARDS, not stop at the project. Narrowing to Pi
 * and then listing a project's twenty-nine cards under it answers "which
 * project" and leaves the actual question - which work - exactly where it was.
 *
 * A card with no session at all goes while a filter is on, for the same reason
 * a project with none does: it cannot answer what is being asked.
 */
export function cardMatchesAgentFilter(
  itemId: string,
  rows: readonly (FilterableRow & { readonly itemId: string })[],
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  return rows.some(row => row.itemId === itemId && matchesAgentFilter(row, selected));
}

/**
 * Drop selections that no longer exist in the tree.
 *
 * An agent stops and its filter row disappears from the menu while the
 * selection survives in storage - leaving a filter on with no visible way to
 * turn it off, which reads as "the app lost my projects".
 */
export function pruneAgentFilter(
  selected: readonly string[],
  available: readonly AgentFilterOption[],
): string[] {
  const live = new Set(available.map(o => o.agentId));
  return selected.filter(id => live.has(id));
}

/**
 * Every agent id in the tree, or just one project's.
 *
 * TWO KEY SPACES, joined here rather than in the component. Our own rows carry
 * the project's ID, because revealing a card needs it; herdr's rows carry the
 * project's NAME, because a pane knows the directory it is in and nothing
 * else. Matching on the wrong one silently returns an empty list, which the
 * filter would then read as "this project has no agents" and hide it.
 */
export function collectFilterableRows(
  sessionRows: readonly {
    readonly projectId?: string; readonly agentId: string; readonly source?: string;
  }[],
  herdrRows: readonly { readonly projectName: string; readonly agentId: string }[],
  project?: { readonly id: string; readonly name: string },
): FilterableRow[] {
  const out: FilterableRow[] = [];
  for (const r of sessionRows) {
    if (project && r.projectId !== project.id) continue;
    if (!r.agentId?.trim()) continue;
    // `source` is what the tree rows already set for a pane herdr is holding.
    out.push({ agentId: r.agentId, fromHerdr: r.source === 'herdr' });
  }
  for (const r of herdrRows) {
    if (project && r.projectName !== project.name) continue;
    if (!r.agentId?.trim()) continue;
    // Every one of these came from herdr by construction.
    out.push({ agentId: r.agentId, fromHerdr: true });
  }
  return out;
}

/**
 * How much a project has to show: cards AND panes.
 *
 * Named rather than added inline because getting it wrong is invisible. The
 * branch under a project - the chevron, the count, the whole expandable list -
 * was gated on the CARD count alone, and the herdr rows lived inside that
 * list. Filtering to herdr removes every card, since those panes belong to the
 * project's own checkout and to no card at all, so projects holding a dozen
 * panes collapsed to empty folders that could not even be opened.
 *
 * Nothing threw and no test failed: the list was correct, it was simply never
 * rendered.
 */
export function projectChildCount(
  cards: readonly unknown[],
  herdrRows: readonly unknown[],
): number {
  return cards.length + herdrRows.length;
}
