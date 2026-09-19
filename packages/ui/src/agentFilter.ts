/**
 * Filtering the tree by which agent is running (96953f6a / CGLAB-266).
 *
 * The sidebar could already be SORTED and not narrowed, which stops helping at
 * the size this tree actually reaches - one project here holds twenty-nine
 * cards and four agents, and the question a person arrives with is usually
 * "where is pi running", not "what happened most recently".
 *
 * THE IDS DO NOT AGREE, and that is the substance of this file. herdr reports
 * `claude` and this app spawns `claude-code`; both are Claude, and filtering on
 * the raw strings would put two entries called Claude in the menu, each hiding
 * half the answer. So the ids are canonicalised before anything is counted or
 * matched.
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
  agentIds: readonly string[],
): AgentFilterOption[] {
  const counts = new Map<string, number>();
  for (const raw of agentIds) {
    if (!raw?.trim()) continue;
    const id = canonicalAgent(raw);
    counts.set(id, (counts.get(id) ?? 0) + 1);
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
export function matchesAgentFilter(agentId: string, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  return selected.includes(canonicalAgent(agentId));
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
  projectAgentIds: readonly string[],
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  return projectAgentIds.some(id => matchesAgentFilter(id, selected));
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
export function collectAgentIds(
  sessionRows: readonly { readonly projectId?: string; readonly agentId: string }[],
  herdrRows: readonly { readonly projectName: string; readonly agentId: string }[],
  project?: { readonly id: string; readonly name: string },
): string[] {
  const out: string[] = [];
  for (const r of sessionRows) {
    if (project && r.projectId !== project.id) continue;
    if (r.agentId) out.push(r.agentId);
  }
  for (const r of herdrRows) {
    if (project && r.projectName !== project.name) continue;
    if (r.agentId) out.push(r.agentId);
  }
  return out;
}
