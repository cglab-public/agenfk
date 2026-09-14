/**
 * Which sessions the rail still shows (CGLAB-194).
 *
 * Asked for directly: the rail should list active sessions, and the ones that
 * died do not need a line. The risk in doing that is picking the wrong axis —
 * "idle" is not "dead", and dropping idle rows would remove the way back to
 * terminals the user has open right now.
 */
import { describe, it, expect } from 'vitest';
import { liveSessions, isWorthShowing } from '../liveSessions';
import type { SessionRow } from '../components/SessionsRail';

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  runId: 'r1',
  itemId: 'i1',
  projectId: 'p1',
  title: 'Fix the flaky test',
  agentId: 'claude-code',
  agentLabel: 'Claude Code',
  state: 'running',
  startedAt: new Date().toISOString(),
  hasTerminal: true,
  ...over,
});

const nothingLive = { isLive: () => false };
/** Older than the liveness window, so age cannot keep a row alive by itself. */
const LONG_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const everythingLive = { isLive: () => true };

describe('a terminal this app owns', () => {
  it('stays while its process is alive, even sitting idle', () => {
    /*
     * The case that decides the whole design. An agent waiting at its prompt
     * is still YOUR session — the tab exists, and the row is how you get back
     * to it. Filtering on "idle" instead of "dead" would take away the route
     * to every terminal you have open, which is most of what the rail is for.
     */
    expect(isWorthShowing(row({ state: 'idle' }), nothingLive)).toBe(true);
  });

  it('stays while it is working', () => {
    expect(isWorthShowing(row({ state: 'running' }), nothingLive)).toBe(true);
  });

  it('stays while it is waiting on a person', () => {
    expect(isWorthShowing(row({ state: 'blocked' }), nothingLive)).toBe(true);
  });

  it('goes once its process has ended', () => {
    expect(isWorthShowing(row({ exited: true, state: 'idle' }), everythingLive)).toBe(false);
  });
});

describe('a run recorded by the hook', () => {
  const hookRun = (over: Partial<SessionRow> = {}) => row({ hasTerminal: false, ...over });

  it('stays while something is still happening on that card', () => {
    expect(isWorthShowing(hookRun({ state: 'running' }), everythingLive)).toBe(true);
  });

  it('stays while it is too young to have said anything yet', () => {
    /*
     * The hole the first version had, and two existing tests caught it:
     * liveness here is the recency of `run:event`, and a run that started a
     * second ago has not emitted one. Filtering on liveness alone meant
     * starting work from a card showed an empty rail until the agent's first
     * tool call.
     */
    expect(isWorthShowing(hookRun({ state: 'idle' }), nothingLive)).toBe(true);
  });

  it('goes when nothing has happened lately', () => {
    /*
     * These are the rows that read as a bare `323cd4ad` — runs from previous
     * launches, titled with the first eight characters of an item id because
     * there is no card title on them. There is no trustworthy end marker to
     * use instead: the hook never issues the closing PATCH, so `status` says
     * `running` forever.
     */
    expect(isWorthShowing(hookRun({ state: 'idle', startedAt: LONG_AGO }), nothingLive)).toBe(false);
  });
});

describe('a failure', () => {
  it('stays however long ago it was', () => {
    // The rail's own comment already argued this: a failure that ages into
    // idle is a failure nobody sees. It is the row that needs a person.
    expect(isWorthShowing(hookFailure(), nothingLive)).toBe(true);
  });

  it('stays even when the terminal that produced it has exited', () => {
    // The rule is listed first precisely so no later one can swallow it.
    expect(isWorthShowing(row({ state: 'failed', exited: true }), nothingLive)).toBe(true);
  });

  function hookFailure() {
    return row({ hasTerminal: false, state: 'failed' });
  }
});

describe('the list as a whole', () => {
  it('keeps the order it was given', () => {
    // Sorting is the rail's job and it sorts by state; reordering here would
    // give one list two opinions about order.
    const rows = [
      row({ runId: 'a', state: 'running' }),
      row({ runId: 'b', state: 'blocked' }),
      row({ runId: 'c', state: 'idle' }),
    ];
    expect(liveSessions(rows, nothingLive).map(r => r.runId)).toEqual(['a', 'b', 'c']);
  });

  it('can empty the rail entirely, and that is a real answer', () => {
    // "Nothing running" is true and useful. The rail has an empty state that
    // says so in a sentence.
    const dead = [
      row({ runId: 'a', exited: true }),
      row({ runId: 'b', hasTerminal: false, state: 'idle', startedAt: LONG_AGO }),
    ];
    expect(liveSessions(dead, nothingLive)).toEqual([]);
  });
});
