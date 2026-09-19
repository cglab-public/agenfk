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
  /** herdr's own word for "this is the pane on screen". */
  readonly focused?: boolean;
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
  /**
   * Where herdr is looking RIGHT NOW.
   *
   * Carried so attaching can skip a redundant focus. herdr's clients are not
   * separate views - MEASURED: a second client receives the first's byte
   * stream exactly, 3443 bytes for 3443 - so focusing is not "move my panel",
   * it is "move the whole herdr", operator's own window included. Doing that
   * when it is already there would be a jump nobody asked for.
   */
  readonly focused: boolean;
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
      focused: p.focused === true,
    });
  }
  return rows;
}

/**
 * The agent id that means "attach to herdr" rather than "start an agent".
 *
 * Must match HERDR_AGENT_ID in the desktop main process, which branches on it
 * to skip the worktree, the tmux wrapper and the run registration. It is
 * duplicated rather than shared because the renderer and the main process do
 * not share a module; a test in each package pins the literal so a rename in
 * one cannot quietly stop matching the other.
 */
export const HERDR_AGENT_ID = 'herdr';

/**
 * The terminal session that attaching to a herdr row opens.
 *
 * KEYED BY SOCKET, not by pane. Attaching shows the whole herdr workspace, so
 * every row from one session is the same terminal; a key per pane would stack
 * identical clients on one daemon and reflow the operator's own window once
 * per click - herdr shares one layout between all its clients, which is the
 * tmux behaviour of clamping to the smallest.
 */
export function herdrAttachSessionId(row: ProjectPaneRow): string {
  return `herdr:${row.socketPath || 'default'}`;
}

export interface HerdrAttachSession {
  readonly id: string;
  readonly itemId: string;
  readonly title: string;
  readonly agentId: string;
  readonly autoApprove: false;
  readonly persist: false;
  readonly openedAt: string;
  readonly branchName: null;
}

/** The descriptor the terminal list takes. `openedAt` is passed in so this stays pure. */
export function herdrAttachSession(row: ProjectPaneRow, openedAt: string): HerdrAttachSession {
  return {
    id: herdrAttachSessionId(row),
    /*
     * There is no card, and nothing downstream looks for one: an attach
     * resolves no worktree. The pane id travels only so the session has
     * something stable behind it.
     */
    itemId: row.paneId,
    title: `herdr — ${row.projectName || row.agentId}`,
    agentId: HERDR_AGENT_ID,
    /*
     * Both meaningless here, and both stated rather than omitted: auto-approve
     * appends flags to an agent we are not starting, and persistence is the
     * one thing herdr already guarantees.
     */
    autoApprove: false,
    persist: false,
    openedAt,
    branchName: null,
  };
}

/**
 * Should attaching also steer herdr to this pane?
 *
 * Only when it is not already there. This is the one call in the feature that
 * reaches outside our own window: herdr's clients are byte-identical mirrors,
 * so `pane.focus` moves the pane, the tab AND the workspace on the operator's
 * real screen. Clicking a row means "take me to that agent" - the same thing
 * clicking a card means everywhere else in this app - but a focus fired when
 * herdr is already showing that pane would be a jump with no cause.
 */
export function shouldFocusOnAttach(row: ProjectPaneRow): boolean {
  return Boolean(row.socketPath) && !row.focused;
}
