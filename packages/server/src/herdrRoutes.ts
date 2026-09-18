/**
 * The herdr adapter, made reachable (cbe172e2 / CGLAB-266).
 *
 * `herdr.ts` was finished, tested at 88% and imported by NOTHING. That is the
 * defect this repository has a name for — complete at both ends, disconnected in
 * the middle — and it has happened here eight times at once. This is the middle.
 *
 * WHAT IT ANSWERS: which herdr sessions are open on this machine, and enough of
 * each to draw a listing — counts, panes, and the agent and status herdr already
 * knows. Not pane content: `pane.read` is on demand, when someone opens one.
 *
 * ABSENCE IS NOT FAILURE, and that is the design decision the whole shape rests
 * on. The setting that turns this on ships ENABLED, so the answer on a machine
 * that never installed herdr has to be an ordinary 200 with an empty list and a
 * sentence a screen can print. An error there would draw a failure over
 * something that is merely not there.
 *
 * ONE DEAD SESSION MUST NOT HIDE THE LIVE ONES. A socket file left behind by a
 * crashed herdr answers ECONNREFUSED forever. If that failed the response, a
 * stale file would make every running session disappear while the developer is
 * looking at their agents.
 *
 * Dependencies are injected so every one of those failures can be staged without
 * a herdr, a socket, or a filesystem.
 */
import { liveHerdrSessions, readSnapshot, type HerdrPane, type HerdrSession, type SnapshotResult } from './herdr.js';

/** How long one session may take before the listing gives up on it. */
export const SESSION_READ_TIMEOUT_MS = 3_000;

export interface HerdrDeps {
  readonly discover: () => HerdrSession[];
  readonly read: (socketPath: string, timeoutMs?: number) => Promise<SnapshotResult>;
}

export interface HerdrSessionView {
  readonly name: string;
  readonly socketPath: string;
  readonly reachable: boolean;
  readonly protocol?: number;
  /**
   * The totals, kept apart from the list on purpose: a field cannot honestly be
   * both a count and the thing counted, and the first draft of this tried.
   */
  readonly counts: {
    readonly workspaces: number; readonly tabs: number;
    readonly panes: number; readonly agents: number;
  };
  /** How many panes each harness holds. The Agents screen lists exactly this. */
  readonly byAgent: Record<string, number>;
  readonly panes: readonly HerdrPane[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface HerdrView {
  /** True when at least one session answered. One stale socket does not count. */
  readonly available: boolean;
  /** Printable, always. "Nothing found" must be distinguishable from "did not look". */
  readonly reason: string;
  readonly sessions: readonly HerdrSessionView[];
}

/**
 * The panes, trimmed to what a listing needs.
 *
 * Deliberately NOT the whole wire record: `scroll` and `revision` are herdr's
 * bookkeeping and mean nothing here, and passing the lot through would make the
 * response grow with fields nobody reads. `agent_status` and
 * `terminal_title_stripped` are the two worth carrying — this repository derives
 * both by scraping the screen, and herdr answers them outright, including for
 * agents like `pi` that publish no OSC title at all.
 */
function paneView(p: HerdrPane): HerdrPane {
  return {
    pane_id: p.pane_id,
    workspace_id: p.workspace_id,
    tab_id: p.tab_id,
    cwd: p.cwd,
    agent: p.agent,
    agent_status: p.agent_status,
    terminal_title_stripped: p.terminal_title_stripped,
    focused: p.focused,
  };
}

function viewOf(session: HerdrSession, result: SnapshotResult): HerdrSessionView {
  if (!result.ok) {
    return {
      name: session.name,
      socketPath: session.socketPath,
      reachable: false,
      counts: { workspaces: 0, tabs: 0, panes: 0, agents: 0 },
      byAgent: {},
      panes: [],
      error: result.error,
    };
  }
  const s = result.snapshot;
  const byAgent: Record<string, number> = {};
  for (const p of s.panes) {
    // A pane with no agent is a shell. It is counted in `panes` and left out of
    // `byAgent`, because a harness breakdown with a "(none)" bucket reads as a
    // harness called none.
    if (typeof p.agent === 'string' && p.agent) byAgent[p.agent] = (byAgent[p.agent] ?? 0) + 1;
  }
  return {
    name: session.name,
    socketPath: session.socketPath,
    reachable: true,
    protocol: s.protocol,
    counts: {
      workspaces: s.workspaces.length, tabs: s.tabs.length,
      panes: s.panes.length, agents: s.agents.length,
    },
    byAgent,
    panes: s.panes.map(paneView),
  };
}

/**
 * The whole listing.
 *
 * READS RUN CONCURRENTLY, and that is not an optimisation. Serial reads on a
 * single-threaded server turn N sessions into N timeouts end to end: four stale
 * sockets at the default would hold the event loop for twelve seconds and every
 * other request behind them. `allSettled` rather than `all`, because one
 * rejection must not take the rest.
 */
export async function buildHerdrSnapshot(deps: HerdrDeps): Promise<HerdrView & { sessions: HerdrSessionView[] }> {
  let sessions: HerdrSession[];
  try {
    sessions = deps.discover();
  } catch (err) {
    // Discovery reads a directory. An unreadable one is a fact to report, not a
    // 500 — the caller asked what is running, and "we could not look" is an
    // answer to that question.
    return { available: false, reason: `could not look for herdr sessions: ${(err as Error).message}`, sessions: [] };
  }

  if (sessions.length === 0) {
    return {
      available: false,
      reason: 'no herdr sessions found on this machine — herdr may not be running, or not installed',
      sessions: [],
    };
  }

  const settled = await Promise.allSettled(
    sessions.map(s => deps.read(s.socketPath, SESSION_READ_TIMEOUT_MS)),
  );
  const views = sessions.map((s, i) => {
    const r = settled[i];
    return viewOf(s, r.status === 'fulfilled'
      ? r.value
      : { ok: false, error: { code: 'unreachable', message: String(r.reason) } });
  });

  const live = views.filter(v => v.reachable).length;
  return {
    available: live > 0,
    reason: live > 0
      ? `${live} of ${views.length} herdr session${views.length === 1 ? '' : 's'} answered`
      : 'herdr sockets are on disk but none answered — they may be left over from a crash',
    sessions: views,
  };
}

/** The real dependencies. Nothing above this decides where to look or how long to wait. */
export const realHerdrDeps: HerdrDeps = {
  discover: () => liveHerdrSessions(),
  read: (socketPath, timeoutMs) => readSnapshot(socketPath, undefined, timeoutMs),
};
