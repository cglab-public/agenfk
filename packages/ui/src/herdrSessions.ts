/**
 * What the Terminal setting says about herdr (08940976 / CGLAB-267).
 *
 * A toggle reading "Attach to open herdr sessions" and nothing else asks the
 * person to take it on faith. This turns the server's answer into the line
 * underneath: what was found, in numbers, and which harnesses are running.
 *
 * ABSENCE READS AS ABSENCE. The setting ships enabled, so a machine that never
 * installed herdr must say "nothing to attach to" — not an error, and not an
 * empty space that leaves someone wondering whether the toggle did anything.
 * A socket that exists but does not answer is the one case worth a warning,
 * because it is the one a person can act on.
 *
 * Pure, so the wording is testable without a socket, a server, or a render.
 */

export interface HerdrPaneView {
  readonly pane_id: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly terminal_title_stripped?: string;
  readonly [k: string]: unknown;
}

export interface HerdrSessionView {
  readonly name: string;
  readonly socketPath: string;
  readonly reachable: boolean;
  readonly protocol?: number;
  readonly counts: {
    readonly workspaces: number; readonly tabs: number;
    readonly panes: number; readonly agents: number;
  };
  readonly byAgent: Record<string, number>;
  readonly panes: readonly HerdrPaneView[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface HerdrView {
  readonly available: boolean;
  readonly reason: string;
  readonly sessions: readonly HerdrSessionView[];
}

export interface DirectoryRow {
  /** The last segment, which is how a developer recognises their own work. */
  readonly dir: string;
  readonly path: string;
  readonly panes: number;
  /** Panes herdr reports as `blocked` — waiting on a human, right now. */
  readonly needsAPerson: number;
}

export interface HerdrDescription {
  readonly headline: string;
  readonly detail: string;
  /** `good` found things · `warn` something is wrong · `quiet` nothing to say. */
  readonly tone: 'good' | 'warn' | 'quiet';
  readonly byDirectory: readonly DirectoryRow[];
}

/** herdr's own word for a pane that is waiting on a person. */
const BLOCKED = 'blocked';

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * The harness breakdown, busiest first.
 *
 * Ranked rather than alphabetical because the line is read at a glance and the
 * first name should be the one doing the most work. Ties fall back to the name
 * so the order never wobbles between reads.
 */
function harnessLine(sessions: readonly HerdrSessionView[]): string {
  const total: Record<string, number> = {};
  for (const s of sessions) {
    for (const [agent, n] of Object.entries(s.byAgent)) total[agent] = (total[agent] ?? 0) + n;
  }
  return Object.entries(total)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([agent, n]) => `${agent} ${n}`)
    .join(' · ');
}

/**
 * Panes grouped by the directory they are working in.
 *
 * `w2:p1P` means nothing to anyone. The repository does — it is how a developer
 * recognises which of their own tasks a pane belongs to.
 */
function byDirectory(sessions: readonly HerdrSessionView[]): DirectoryRow[] {
  const rows = new Map<string, { panes: number; needsAPerson: number }>();
  for (const s of sessions) {
    for (const p of s.panes) {
      const path = typeof p.cwd === 'string' ? p.cwd : '';
      if (!path) continue;
      const row = rows.get(path) ?? { panes: 0, needsAPerson: 0 };
      row.panes += 1;
      if (p.agent_status === BLOCKED) row.needsAPerson += 1;
      rows.set(path, row);
    }
  }
  return [...rows.entries()].map(([path, r]) => ({
    dir: path.split('/').filter(Boolean).pop() ?? path,
    path,
    panes: r.panes,
    needsAPerson: r.needsAPerson,
  }));
}

/** The whole line, from the server's answer. */
export function describeHerdr(view: HerdrView): HerdrDescription {
  const live = view.sessions.filter(s => s.reachable);
  const dead = view.sessions.length - live.length;

  if (live.length === 0) {
    // Two different silences, and only one of them is a problem.
    const stale = view.sessions.length > 0;
    return {
      tone: stale ? 'warn' : 'quiet',
      headline: stale
        ? `${plural(view.sessions.length, 'herdr socket')} on disk, none answering`
        : 'No herdr sessions found — nothing to attach to',
      detail: stale
        ? `${view.reason}. ${view.sessions.map(s => s.error?.message).filter(Boolean).join('; ')}`
        : 'herdr may not be running, or not installed. This setting costs nothing while it is absent.',
      byDirectory: [],
    };
  }

  const panes = live.reduce((n, s) => n + s.counts.panes, 0);
  const agents = live.reduce((n, s) => n + s.counts.agents, 0);
  const protocols = [...new Set(live.map(s => s.protocol).filter(Boolean))];

  const bits = [harnessLine(live)];
  if (protocols.length > 0) bits.push(`protocol ${protocols.join(', ')}`);
  if (dead > 0) bits.push(`${dead} unreachable`);

  return {
    tone: 'good',
    headline: `${plural(live.length, 'session')} · ${plural(panes, 'pane')} · ${plural(agents, 'agent')}`,
    detail: bits.filter(Boolean).join(' · '),
    byDirectory: byDirectory(live),
  };
}
