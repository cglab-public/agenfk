/**
 * The route that makes the herdr adapter reachable (cbe172e2 / CGLAB-266).
 *
 * The module this serves was complete, tested at 88% and imported by NOTHING —
 * the defect this repository has hit eight times at once and has a name for.
 * These tests are about the half that turns it into something a screen can use,
 * so they are mostly about the FAILURE shapes: a machine with no herdr, a socket
 * left behind by a crash, and one dead session among live ones.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildHerdrSnapshot, type HerdrDeps } from '../herdrRoutes';
import type { HerdrSession, SnapshotResult } from '../herdr';

const SESSION = (name: string): HerdrSession => ({ name, socketPath: `/cfg/${name}.sock` });

const snap = (panes: Record<string, unknown>[]): SnapshotResult => ({
  ok: true,
  snapshot: {
    protocol: 17,
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1' }],
    panes,
    agents: panes.filter(p => p.agent),
  },
});

/*
 * The fixture carries the fields the trimming is supposed to DROP - `revision`,
 * `scroll`, `agent_session` - because a test that asserts the absence of
 * something the input never had cannot fail. Mutation found that: spreading the
 * whole wire record through changed nothing and the suite stayed green.
 */
const PANES = [
  { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working', cwd: '/repo',
    revision: 12, scroll: 3, agent_session: { source: 'herdr:claude' } },
  { pane_id: 'w1:p2', agent: 'pi', agent_status: 'idle', cwd: '/repo',
    revision: 4, scroll: 0 },
  { pane_id: 'w1:p3', cwd: '/repo', revision: 1, scroll: 0 },
];

function deps(over: Partial<HerdrDeps> = {}): HerdrDeps {
  return {
    discover: () => [SESSION('default')],
    read: async () => snap(PANES),
    ...over,
  };
}

/* ── the machine that has no herdr ─────────────────────────────────────── */

describe('when herdr is not there', () => {
  it('answers 200 with an empty list, not an error', async () => {
    /*
     * The setting that turns this on ships ENABLED, so the answer on a machine
     * that never installed herdr has to be ordinary. An error here would make a
     * screen draw a failure over something that is simply absent, and the
     * difference is the whole reason the toggle can default to on.
     */
    const body = await buildHerdrSnapshot(deps({ discover: () => [] }));
    expect(body.available).toBe(false);
    expect(body.sessions).toEqual([]);
  });

  it('says WHY in words a screen can print', async () => {
    // "Nothing found" has to be distinguishable from "we did not look".
    const body = await buildHerdrSnapshot(deps({ discover: () => [] }));
    expect(body.reason).toMatch(/no .*herdr|not running|nenhuma/i);
  });

  it('never lets a filesystem failure become a 500', async () => {
    // Discovery reads a directory. An unreadable one is not the caller's problem.
    const body = await buildHerdrSnapshot(deps({
      discover: () => { throw new Error('EACCES'); },
    }));
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/EACCES/);
  });
});

/* ── the ordinary answer ───────────────────────────────────────────────── */

describe('when herdr is running', () => {
  it('carries the counts a screen needs to prove the setting is doing something', async () => {
    /*
     * The Settings screen shows "23 panes, 18 agents" rather than a bare toggle,
     * because a number convinces and an abstraction does not. The number has to
     * come from here — inventing it on the client is the defect an adversarial
     * review caught on another screen today.
     */
    const body = await buildHerdrSnapshot(deps());
    expect(body.available).toBe(true);
    expect(body.sessions[0]).toMatchObject({
      name: 'default', reachable: true,
      counts: { workspaces: 1, tabs: 1, panes: 3, agents: 2 },
    });
  });

  it('counts agents by harness, which is what the Agents screen lists', async () => {
    // The point of the whole card: `pi` panes exist and this product cannot see
    // them, because `pi` publishes no OSC title and is not launchable here.
    const body = await buildHerdrSnapshot(deps());
    expect(body.sessions[0].byAgent).toEqual({ claude: 1, pi: 1 });
  });

  it('carries agent_status, so the screen does not have to scrape a screen', async () => {
    const body = await buildHerdrSnapshot(deps());
    const pane = body.sessions[0].panes.find(p => p.agent === 'pi');
    expect(pane?.agent_status).toBe('idle');
  });

  it('trims the wire record instead of passing it through', async () => {
    /*
     * `pane.read` is on demand, when someone opens one - so no content here. And
     * herdr's own bookkeeping (`revision`, `scroll`, `agent_session`) means
     * nothing to a listing; carrying it would grow the response with fields
     * nobody reads.
     */
    const body = await buildHerdrSnapshot(deps());
    for (const p of body.sessions[0].panes) {
      expect(p).not.toHaveProperty('text');
      expect(p, p.pane_id).not.toHaveProperty('revision');
      expect(p, p.pane_id).not.toHaveProperty('scroll');
      expect(p, p.pane_id).not.toHaveProperty('agent_session');
    }
    // And it keeps the ones that earn their place.
    expect(body.sessions[0].panes[0]).toMatchObject({ pane_id: 'w1:p1', agent_status: 'working' });
  });
});

/* ── the failures that must not hide each other ────────────────────────── */

describe('when a session is dead', () => {
  it('reports it unreachable WITHOUT hiding the live ones', async () => {
    /*
     * A socket file left behind by a crashed herdr answers ECONNREFUSED. If one
     * dead session failed the whole response, a stale file would make every
     * live session disappear — and the screen would say "no sessions" while the
     * developer is looking at their agents.
     */
    const body = await buildHerdrSnapshot(deps({
      discover: () => [SESSION('dead'), SESSION('live')],
      read: async path => path.includes('dead')
        ? { ok: false, error: { code: 'unreachable', message: 'ECONNREFUSED' } }
        : snap(PANES),
    }));
    expect(body.sessions.map(s => [s.name, s.reachable]))
      .toEqual([['dead', false], ['live', true]]);
    expect(body.sessions[1].panes).toHaveLength(3);
  });

  it('survives a read that THROWS, not only one that answers with an error', async () => {
    /*
     * The two are different paths and only one had a test. `readSnapshot` is
     * written to return `{ok:false}`, but it calls an injected transport, and a
     * transport that throws - a bug, a stack overflow, anything - must not take
     * the listing with it. `allSettled` handles it; nothing proved that.
     */
    const body = await buildHerdrSnapshot(deps({
      discover: () => [SESSION('throws'), SESSION('live')],
      read: async path => {
        if (path.includes('throws')) throw new Error('transport exploded');
        return snap(PANES);
      },
    }));
    expect(body.sessions.map(s => s.reachable)).toEqual([false, true]);
    expect(body.sessions[0].error?.message).toMatch(/exploded/);
    expect(body.available).toBe(true);
  });

  it('keeps the reason on the dead one', async () => {
    const body = await buildHerdrSnapshot(deps({
      discover: () => [SESSION('dead')],
      read: async () => ({ ok: false, error: { code: 'timeout', message: 'did not answer' } }),
    }));
    expect(body.sessions[0].error).toMatchObject({ code: 'timeout' });
  });

  it('counts as available when ANY session answered', async () => {
    // One stale socket must not make a running herdr look absent.
    const body = await buildHerdrSnapshot(deps({
      discover: () => [SESSION('dead'), SESSION('live')],
      read: async path => path.includes('dead')
        ? { ok: false, error: { code: 'unreachable', message: 'x' } }
        : snap(PANES),
    }));
    expect(body.available).toBe(true);
  });

  it('is NOT available when every session is dead', async () => {
    const body = await buildHerdrSnapshot(deps({
      read: async () => ({ ok: false, error: { code: 'unreachable', message: 'x' } }),
    }));
    expect(body.available).toBe(false);
  });
});

/* ── the single-threaded server ────────────────────────────────────────── */

describe('reading many sessions', () => {
  it('reads them CONCURRENTLY, not one after another', async () => {
    /*
     * Serial reads on a single-threaded server turn N sessions into N timeouts
     * stacked end to end: four stale sockets at the 5s default would hold the
     * event loop's attention for twenty seconds. Concurrency is not an
     * optimisation here, it is the difference between a slow answer and a
     * server that stops answering anything else.
     */
    let live = 0;
    let peak = 0;
    const body = await buildHerdrSnapshot(deps({
      discover: () => ['a', 'b', 'c', 'd'].map(SESSION),
      read: async () => {
        live += 1; peak = Math.max(peak, live);
        await new Promise(r => setTimeout(r, 20));
        live -= 1;
        return snap(PANES);
      },
    }));
    expect(body.sessions).toHaveLength(4);
    expect(peak, 'all four should be in flight at once').toBe(4);
  });

  it('gives every read a deadline, so one hung socket cannot stall the answer', async () => {
    const read = vi.fn(async () => snap(PANES));
    await buildHerdrSnapshot(deps({ read }));
    // The deps signature carries the timeout; the route must pass one.
    expect(read).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
  });
});
