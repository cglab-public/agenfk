/**
 * herdr panes as rows in the tree that already exists (96953f6a / CGLAB-266).
 *
 * The first attempt built a separate Sessions screen. It showed the right data,
 * and it was the wrong shape: the product already has a tree of project → card
 * → the agents running under them, and a second list about the same work makes
 * a person choose which one to believe. A herdr pane carries everything one of
 * those rows needs, so it becomes one.
 *
 * TWO DESTINATIONS, AND THE THIRD IS NOT A GAP. A pane inside a card's worktree
 * joins that card. A pane in the project's own checkout joins the project —
 * which is where nearly all of them are today, because AgEnFK does not launch
 * into herdr yet, so a design that only handled cards would show almost nothing.
 * A pane that is neither is external, and stays external.
 */
import type { SessionRow, SessionState } from './sessionRow';

export interface PaneOwner {
  readonly kind: 'card' | 'project' | 'external';
  readonly cardId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly branchName?: string;
  readonly projectName?: string;
}

export interface OwnedPane {
  readonly pane_id: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly terminal_title_stripped?: string;
  readonly owner?: PaneOwner;
  readonly [k: string]: unknown;
}

/** A pane that belongs to a project but to no card. */
export interface ProjectPaneRow {
  readonly paneId: string;
  /**
   * The session this pane came from.
   *
   * Carried because reading a pane needs it: herdr can hold several sessions,
   * each its own socket, and the pane id alone does not say which one answers
   * for it. Asking the wrong socket gets `pane_not_found` for a pane that is
   * very much alive.
   */
  readonly socketPath: string;
  readonly projectName: string;
  readonly agentId: string;
  readonly title: string;
  readonly state: SessionState;
  readonly needsAPerson: boolean;
}

/**
 * herdr's word, in the tree's vocabulary.
 *
 * `unknown` becomes `unverifiable`, not `idle`. herdr answers `unknown` for a
 * shell rather than guessing, and turning that into `idle` would invent a fact
 * the multiplexer deliberately refused to state — `unverifiable` is this
 * product's own word for "no evidence", which is exactly what herdr is saying.
 *
 * And `blocked` maps straight through. It is the state `runState` never
 * produces — the amber dot and the "needs you" count had no producer at all
 * until herdr supplied one.
 */
export function herdrStateOf(status: string | undefined): SessionState {
  switch (status) {
    case 'working': return 'running';
    case 'idle': return 'idle';
    case 'blocked': return 'blocked';
    default: return 'unverifiable';
  }
}

function titleOf(p: OwnedPane): string {
  const t = (p.terminal_title_stripped ?? '').trim();
  return t || (p.cwd ?? '').split('/').filter(Boolean).pop() || p.pane_id;
}

function agentOf(p: OwnedPane): string {
  return (p.agent ?? '').trim() || 'shell';
}

/**
 * Panes that belong to a card, as rows under it.
 *
 * KEYED BY CARD AND AGENT, like every other row in that tree. Keying by the
 * card alone once collapsed two terminals into a single row that carried the
 * second's identity while clicking it activated the first — the tree learned
 * that the hard way and this must not re-teach it.
 *
 * The `runId` is prefixed rather than invented: the tree acts on that id, and a
 * herdr pane is NOT an AgEnFK run. A row that pretended otherwise would aim
 * STOP at a run that does not exist, in a terminal this product never started.
 */
export function herdrSessionRows(panes: readonly OwnedPane[]): (SessionRow & { source: 'herdr' })[] {
  const rows: (SessionRow & { source: 'herdr' })[] = [];
  const seen = new Set<string>();
  for (const p of panes) {
    if (p.owner?.kind !== 'card' || !p.owner.cardId) continue;
    const agentId = agentOf(p);
    // `\u0000` as an ESCAPE, never the literal byte. `AppShell` keys its own
    // rows the same way, and a raw NUL in source makes `grep` skip the whole
    // file in silence - which is an open bug against `server.ts:986` filed
    // earlier today, and which this file reproduced within the hour.
    const key = `${p.owner.cardId}\u0000${agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      runId: `herdr:${p.pane_id}`,
      itemId: p.owner.cardId,
      title: titleOf(p),
      agentId,
      agentLabel: agentId,
      state: herdrStateOf(p.agent_status),
      source: 'herdr',
    } as SessionRow & { source: 'herdr' });
  }
  return rows;
}

/**
 * Panes that belong to a project but to no card.
 *
 * MEASURED: eighteen of twenty-four panes on the machine this was built for.
 * Work happens in the repository's own checkout, because nothing AgEnFK starts
 * runs in herdr yet — so a design that only handled cards would have hidden
 * almost everything the feature exists to show.
 */
export function herdrProjectRows(
  panes: readonly OwnedPane[],
  socketOf: (paneId: string) => string = () => '',
): ProjectPaneRow[] {
  const rows: ProjectPaneRow[] = [];
  for (const p of panes) {
    if (p.owner?.kind !== 'project' || !p.owner.projectName) continue;
    const state = herdrStateOf(p.agent_status);
    rows.push({
      paneId: p.pane_id,
      socketPath: socketOf(p.pane_id),
      projectName: p.owner.projectName,
      agentId: agentOf(p),
      title: titleOf(p),
      state,
      needsAPerson: state === 'blocked',
    });
  }
  return rows;
}
