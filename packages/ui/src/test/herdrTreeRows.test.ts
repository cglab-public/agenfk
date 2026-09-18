/**
 * herdr panes as rows in the tree that already exists (96953f6a / CGLAB-266).
 *
 * The first attempt at this built a separate Sessions screen, which duplicated
 * a surface the product already had and made a person choose between two lists
 * about the same work. The tree is where sessions live: project, card, and the
 * agents running under them. A herdr pane carries everything one of those rows
 * needs, so it becomes one.
 */
import { describe, it, expect } from 'vitest';
import { herdrSessionRows, herdrProjectRows, herdrStateOf, type OwnedPane } from '../herdrTreeRows';

const pane = (over: Partial<OwnedPane> = {}): OwnedPane => ({
  pane_id: 'w1:p1',
  cwd: '/repo',
  agent: 'claude',
  agent_status: 'idle',
  terminal_title_stripped: 'Some title',
  owner: { kind: 'card', cardId: 'c-1', title: 'Adapter herdr', status: 'IN_PROGRESS', projectName: 'agenfk' },
  ...over,
});

/* ── the state, translated honestly ────────────────────────────────────── */

describe('what herdr says, in the tree\'s vocabulary', () => {
  it('maps working to running and idle to idle', () => {
    expect(herdrStateOf('working')).toBe('running');
    expect(herdrStateOf('idle')).toBe('idle');
  });

  it('maps BLOCKED to blocked, which nothing in this product could produce before', () => {
    /*
     * `runState` only ever answers failed/running/idle/unverifiable, so the
     * amber dot and the "needs you" count had no producer. herdr has one, and
     * two panes were in it when this was written.
     */
    expect(herdrStateOf('blocked')).toBe('blocked');
  });

  it('maps herdr\'s UNKNOWN to unverifiable, not to idle', () => {
    /*
     * herdr answers `unknown` for a shell rather than guessing. Turning that
     * into `idle` would invent a fact it deliberately refused to state;
     * `unverifiable` is this product's own word for "no evidence", which is
     * exactly what herdr is saying.
     */
    expect(herdrStateOf('unknown')).toBe('unverifiable');
    expect(herdrStateOf(undefined)).toBe('unverifiable');
  });
});

/* ── panes that belong to a card ───────────────────────────────────────── */

describe('a pane inside a card\'s worktree', () => {
  it('becomes a session row under that card', () => {
    const [row] = herdrSessionRows([pane()]);
    expect(row.itemId).toBe('c-1');
    expect(row.agentId).toBe('claude');
    expect(row.state).toBe('idle');
  });

  it('is keyed by card AND agent, like every other row in that tree', () => {
    /*
     * Keying by card alone collapsed two terminals into one row that carried
     * the second's identity while clicking it activated the first. The tree
     * learned that the hard way; this must not re-teach it.
     */
    const rows = herdrSessionRows([
      pane({ pane_id: 'a', agent: 'claude' }),
      pane({ pane_id: 'b', agent: 'pi' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.agentId))).toEqual(new Set(['claude', 'pi']));
  });

  it('carries a runId that says where the row came from', () => {
    // The tree acts on runId. A herdr pane is not an AgEnFK run, and a row that
    // pretended otherwise would have STOP aimed at a run that does not exist.
    const [row] = herdrSessionRows([pane()]);
    expect(row.runId).toMatch(/herdr/);
    expect(row.runId).toContain('w1:p1');
  });

  it('titles the row with what the agent is doing', () => {
    const [row] = herdrSessionRows([pane({ terminal_title_stripped: '◐ Criar branch' })]);
    expect(row.title).toBe('◐ Criar branch');
  });

  it('leaves panes that belong to no card out of the card rows', () => {
    expect(herdrSessionRows([pane({ owner: { kind: 'external' } })])).toEqual([]);
    expect(herdrSessionRows([pane({ owner: { kind: 'project', projectName: 'agenfk' } })])).toEqual([]);
  });
});

/* ── panes that belong to a project but no card ────────────────────────── */

describe('a pane in the project but in no card', () => {
  it('becomes a row on the project itself, rather than being dropped', () => {
    /*
     * MEASURED: eighteen of twenty-four panes on this machine are this - work
     * in the repository's own checkout, because AgEnFK does not launch into
     * herdr yet. Dropping them would hide almost everything the feature is for.
     */
    const rows = herdrProjectRows([pane({ owner: { kind: 'project', projectName: 'agenfk' } })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].projectName).toBe('agenfk');
    expect(rows[0].agentId).toBe('claude');
  });

  it('groups them by project, and counts the ones waiting on a person', () => {
    const rows = herdrProjectRows([
      pane({ pane_id: 'a', owner: { kind: 'project', projectName: 'agenfk' }, agent_status: 'blocked' }),
      pane({ pane_id: 'b', owner: { kind: 'project', projectName: 'agenfk' }, agent_status: 'idle' }),
      pane({ pane_id: 'c', owner: { kind: 'project', projectName: 'outro' }, agent_status: 'idle' }),
    ]);
    expect(rows.filter(r => r.projectName === 'agenfk')).toHaveLength(2);
    expect(rows.filter(r => r.needsAPerson)).toHaveLength(1);
  });

  it('keeps card-owned and external panes out of the project rows', () => {
    expect(herdrProjectRows([pane()])).toEqual([]);
    expect(herdrProjectRows([pane({ owner: { kind: 'external' } })])).toEqual([]);
  });
});

/* ── what a row must never claim ───────────────────────────────────────── */

describe('what these rows refuse to be', () => {
  it('never carries an AgEnFK runId that could be acted on', () => {
    // Nothing in the tree may send STOP to a pane this product did not start.
    for (const row of herdrSessionRows([pane()])) {
      expect(row.runId.startsWith('herdr:')).toBe(true);
    }
  });

  it('marks the row as external in origin, so the UI can say so', () => {
    const [row] = herdrSessionRows([pane()]);
    expect(row.source).toBe('herdr');
  });
});
