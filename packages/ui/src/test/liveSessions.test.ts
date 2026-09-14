/**
 * Which sessions the rail still shows (CGLAB-194).
 *
 * Asked for directly: the rail should list active sessions, and the ones that
 * died do not need a line. The risk in doing that is picking the wrong axis —
 * "idle" is not "dead", and dropping idle rows would remove the way back to
 * terminals the user has open right now.
 *
 * REWRITTEN after an independent review. The first version was built on a
 * premise that had stopped being true: that the hook never closes a run, so
 * `status` reads `running` forever. It closes them now, and the filter was
 * ignoring the one trustworthy end marker it had — see liveSessions.ts.
 *
 * Every fixture below that is not specifically about a young row is given an
 * OLD `startedAt`. The first version defaulted them to `Date.now()`, and six of
 * its eleven tests passed with the rule they named deleted, because every row
 * fell through to the age rule and was kept for the wrong reason.
 */
import { describe, it, expect } from 'vitest';
import { liveSessions, isWorthShowing } from '../liveSessions';
import type { SessionRow } from '../components/SessionsRail';

/** This app launched an hour ago, so "started this session" is a real choice. */
const LAUNCHED_AT = Date.now() - 60 * 60_000;
/** Before the launch: a row from some previous run of the app. */
const PREVIOUS_LAUNCH = new Date(LAUNCHED_AT - 60_000).toISOString();
/** After the launch: a row this app session started itself. */
const THIS_LAUNCH = new Date(LAUNCHED_AT + 60_000).toISOString();

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  runId: 'r1',
  itemId: 'i1',
  projectId: 'p1',
  title: 'Fix the flaky test',
  agentId: 'claude-code',
  agentLabel: 'Claude Code',
  state: 'running',
  startedAt: PREVIOUS_LAUNCH,
  hasTerminal: true,
  ...over,
});

const nothingLive = { isLive: () => false, appStartedAt: LAUNCHED_AT };
const everythingLive = { isLive: () => true, appStartedAt: LAUNCHED_AT };

describe('a terminal this app owns', () => {
  it('stays while its process is alive, even sitting idle', () => {
    /*
     * The case that decides the whole design. An agent waiting at its prompt
     * is still YOUR session — the tab exists, and the row is how you get back
     * to it. Filtering on "idle" instead of "dead" would take away the route
     * to every terminal you have open, which is most of what the rail is for.
     *
     * An hour old and nothing live, so only the terminal rule can keep it.
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

  it('ignores the run status, which describes a different thing', () => {
    // A terminal's truth is its process. `runStatus` belongs to the hook's
    // record, and a closed record must not close a shell the user has open.
    expect(isWorthShowing(row({ runStatus: 'done', state: 'idle' }), nothingLive)).toBe(true);
  });
});

describe('a run recorded by the hook', () => {
  const hookRun = (over: Partial<SessionRow> = {}) => row({ hasTerminal: false, ...over });

  it('goes as soon as the hook says it ended', () => {
    /*
     * THE correction. `status` is a real end marker — the hook PATCHes it to
     * `done` on Stop/SessionEnd — and the first version ignored it, so a run
     * that finished ten seconds ago was still listed. It is checked before
     * liveness deliberately: a run can be closed while its last event is still
     * inside the live window, and "finished" beats "recently noisy".
     */
    expect(isWorthShowing(hookRun({ runStatus: 'done', startedAt: THIS_LAUNCH }), everythingLive))
      .toBe(false);
  });

  it('stays while something is still happening on that card', () => {
    // Old, from a previous launch: liveness is the only thing keeping it.
    expect(isWorthShowing(hookRun({ runStatus: 'running' }), everythingLive)).toBe(true);
  });

  it('stays through a long quiet stretch if this app session started it', () => {
    /*
     * The regression the review caught, and the reason launch time replaced
     * the age window. `run:event` is emitted for SEVEN tool names only
     * (claude-events.ts) — Bash, Edit, Write, NotebookEdit, Task, WebFetch,
     * Artifact. A four-minute `npm test` emits NOTHING for four minutes, so a
     * rule that keeps a row only while it is live made the row vanish in the
     * middle of the work and come back afterwards.
     */
    expect(isWorthShowing(hookRun({ runStatus: 'running', startedAt: THIS_LAUNCH }), nothingLive))
      .toBe(true);
  });

  it('goes when it predates this launch and has said nothing since', () => {
    /*
     * The rows this card exists to remove: runs from previous launches, which
     * read as a bare `323cd4ad` because a run with no card title falls back to
     * the first eight characters of its item id. The app was killed before the
     * hook could close them, so `status` still says `running` and always will.
     */
    expect(isWorthShowing(hookRun({ runStatus: 'running' }), nothingLive)).toBe(false);
  });

  it('keeps a row with no status at all, if this session started it', () => {
    // Older records have no status. Absent is not "ended".
    expect(isWorthShowing(hookRun({ startedAt: THIS_LAUNCH }), nothingLive)).toBe(true);
  });

  it('keeps a row whose startedAt is in the future', () => {
    /*
     * A clock-skew guard that pointed the wrong way. The first version demanded
     * `age >= 0`, which DROPPED a future timestamp — the maximally young row,
     * the exact case the rule exists to keep. Only matters against a
     * non-local server, but it must not fail in the direction that hides work.
     */
    const ahead = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(isWorthShowing(hookRun({ runStatus: 'running', startedAt: ahead }), nothingLive))
      .toBe(true);
  });

  it('drops a row whose startedAt cannot be read, rather than guessing', () => {
    // Unparseable is not young. Nothing produces this today; it is here so the
    // NaN comparison is a decision instead of an accident.
    expect(isWorthShowing(hookRun({ runStatus: 'running', startedAt: 'not-a-date' }), nothingLive))
      .toBe(false);
  });
});

describe('a failure', () => {
  it('stays however long ago it was', () => {
    // The rail's own comment already argued this: a failure that ages into
    // idle is a failure nobody sees. It is the row that needs a person.
    // Genuinely old, and nothing live — only the failure rule can keep it.
    expect(isWorthShowing(row({ hasTerminal: false, state: 'failed' }), nothingLive)).toBe(true);
  });

  it('stays even when the hook has closed the run', () => {
    // The rule is listed first precisely so no later one can swallow it, and
    // `runStatus: 'failed'` is the case where the end marker and the failure
    // arrive together.
    expect(isWorthShowing(row({ hasTerminal: false, state: 'failed', runStatus: 'failed' }), nothingLive))
      .toBe(true);
  });

  it('stays even when the terminal that produced it has exited', () => {
    expect(isWorthShowing(row({ state: 'failed', exited: true }), nothingLive)).toBe(true);
  });
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
      row({ runId: 'b', hasTerminal: false, runStatus: 'done', startedAt: THIS_LAUNCH }),
      row({ runId: 'c', hasTerminal: false, runStatus: 'running' }),
    ];
    expect(liveSessions(dead, nothingLive)).toEqual([]);
  });
});
