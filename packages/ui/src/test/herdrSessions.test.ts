/**
 * The sentence the Terminal setting prints (08940976 / CGLAB-267).
 *
 * A toggle that says "Attach to open herdr sessions" and nothing else asks the
 * person to take it on faith. The line under it has to say what was actually
 * found — and on a machine with no herdr it has to say THAT, rather than
 * disappearing or drawing a failure over something that is merely absent.
 *
 * Pure, so the wording is testable without a socket, a server, or a render.
 */
import { describe, it, expect } from 'vitest';
import { describeHerdr, type HerdrView } from '../herdrSessions';

const view = (over: Partial<HerdrView> = {}): HerdrView => ({
  available: true,
  reason: '1 of 1 herdr session answered',
  sessions: [{
    name: 'default',
    socketPath: '/cfg/herdr/herdr.sock',
    reachable: true,
    protocol: 17,
    counts: { workspaces: 12, tabs: 24, panes: 24, agents: 18 },
    byAgent: { claude: 11, pi: 7 },
    panes: [],
  }],
  ...over,
});

describe('when herdr is running', () => {
  it('says what it found, in the numbers that prove the setting is doing something', () => {
    // "24 panes" convinces; "Attach to open sessions" does not.
    const s = describeHerdr(view());
    expect(s.headline).toMatch(/24 panes/);
    expect(s.headline).toMatch(/18 agents/);
  });

  it('names the harnesses, because that is the point of the whole feature', () => {
    /*
     * Seven of these are `pi`, which this product cannot launch and cannot
     * detect — `pi` publishes no OSC title, so the screen-scraping path is
     * blind to it. herdr names it outright.
     */
    const s = describeHerdr(view());
    expect(s.detail).toMatch(/claude 11/);
    expect(s.detail).toMatch(/pi 7/);
  });

  it('puts the busiest harness first, so the line reads as a ranking', () => {
    const s = describeHerdr(view({
      sessions: [{ ...view().sessions[0], byAgent: { pi: 2, claude: 9, codex: 5 } }],
    }));
    expect(s.detail.indexOf('claude')).toBeLessThan(s.detail.indexOf('codex'));
    expect(s.detail.indexOf('codex')).toBeLessThan(s.detail.indexOf('pi'));
  });

  it('carries the version, because a protocol is a compatibility fact', () => {
    expect(describeHerdr(view()).detail).toMatch(/protocol 17/);
  });

  it('counts sessions when there is more than one', () => {
    const one = view().sessions[0];
    const s = describeHerdr(view({
      sessions: [one, { ...one, name: 'work' }],
      reason: '2 of 2 herdr sessions answered',
    }));
    expect(s.headline).toMatch(/2 sessions/);
    // And the totals add up rather than reporting only the first.
    expect(s.headline).toMatch(/48 panes/);
  });
});

describe('when herdr is not there', () => {
  it('says so plainly, instead of vanishing', () => {
    /*
     * THE CASE THAT LETS THE TOGGLE DEFAULT TO ON. A machine that never
     * installed herdr has to read as "nothing to attach to", not as an error
     * and not as an empty space that leaves the person wondering whether the
     * setting did anything at all.
     */
    const s = describeHerdr({ available: false, reason: 'no herdr sessions found', sessions: [] });
    expect(s.headline).toMatch(/no herdr|not running|nothing/i);
    expect(s.tone).toBe('quiet');
  });

  it('is never an error tone for mere absence', () => {
    const s = describeHerdr({ available: false, reason: 'no herdr sessions found', sessions: [] });
    expect(s.tone).not.toBe('bad');
  });

  it('IS a warning when sockets exist but none answered', () => {
    // A socket left behind by a crash is different from herdr not being there,
    // and the person can act on one of them.
    const s = describeHerdr({
      available: false,
      reason: 'herdr sockets are on disk but none answered',
      sessions: [{
        name: 'default', socketPath: '/cfg/herdr/herdr.sock', reachable: false,
        counts: { workspaces: 0, tabs: 0, panes: 0, agents: 0 }, byAgent: {}, panes: [],
        error: { code: 'unreachable', message: 'ECONNREFUSED' },
      }],
    });
    expect(s.tone).toBe('warn');
    expect(s.detail).toMatch(/ECONNREFUSED|left over|crash/i);
  });
});

describe('when one session of several is dead', () => {
  it('reports the live ones and does not hide them behind the dead one', () => {
    const live = view().sessions[0];
    const s = describeHerdr({
      available: true,
      reason: '1 of 2 herdr sessions answered',
      sessions: [
        { ...live, name: 'stale', reachable: false, counts: { workspaces: 0, tabs: 0, panes: 0, agents: 0 }, byAgent: {} },
        live,
      ],
    });
    expect(s.tone).toBe('good');
    expect(s.headline).toMatch(/24 panes/);
    expect(s.detail).toMatch(/1 unreachable|stale/i);
  });
});

describe('the pane list the screen can show', () => {
  it('groups panes by the directory they are working in', () => {
    // A developer recognises their work by the repository, not by `w2:p1P`.
    const s = describeHerdr(view({
      sessions: [{
        ...view().sessions[0],
        panes: [
          { pane_id: 'a', cwd: '/x/agenfk', agent: 'claude', agent_status: 'working' },
          { pane_id: 'b', cwd: '/x/agenfk', agent: 'pi', agent_status: 'idle' },
          { pane_id: 'c', cwd: '/x/horizon', agent: 'claude', agent_status: 'blocked' },
        ],
      }],
    }));
    expect(s.byDirectory).toEqual([
      { dir: 'agenfk', path: '/x/agenfk', panes: 2, needsAPerson: 0 },
      { dir: 'horizon', path: '/x/horizon', panes: 1, needsAPerson: 1 },
    ]);
  });

  it('counts a BLOCKED pane as needing a person, which is the state we cannot produce ourselves', () => {
    /*
     * `blocked` is unreachable in this product's own Agents screen — `runState`
     * only ever answers failed/running/idle/unverifiable — so the amber dot has
     * never had a producer. herdr answers it, and two panes are in it right now.
     */
    const s = describeHerdr(view({
      sessions: [{
        ...view().sessions[0],
        panes: [{ pane_id: 'a', cwd: '/x/y', agent: 'claude', agent_status: 'blocked' }],
      }],
    }));
    expect(s.byDirectory[0].needsAPerson).toBe(1);
  });
});
