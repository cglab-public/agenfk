/**
 * Clicking a herdr row opens a terminal (96953f6a / CGLAB-266).
 *
 * The version this replaced put a read-only mirror with a keypad in front of
 * the terminal column and hid the real terminals behind it. It was modelled on
 * collie, which is a bridge you point a phone at - between a phone and a
 * session there is no PTY to be had, so a photograph is its ceiling. We run on
 * the same machine as the daemon, and this repository already attached to a
 * multiplexer inside its own PTY for tmux.
 *
 * So there is no second surface any more, and these tests are about the
 * session that opening one produces.
 */
import { describe, it, expect } from 'vitest';
import {
  herdrAttachSession,
  herdrAttachSessionId,
  HERDR_AGENT_ID,
  type ProjectPaneRow,
} from '../herdrTreeRows';

const row = (over: Partial<ProjectPaneRow> = {}): ProjectPaneRow => ({
  paneId: 'w8:p1',
  socketPath: '/cfg/herdr/herdr.sock',
  agentId: 'pi',
  title: 'π - catalog',
  projectName: 'cglab-agentic-catalog',
  state: 'idle',
  needsAPerson: false,
  ...over,
});

const AT = '2026-09-19T00:00:00.000Z';

/* ── one terminal per session, not per pane ────────────────────────────── */

describe('what the session is keyed by', () => {
  it('keys by the SOCKET, because an attach shows the whole workspace', () => {
    /*
     * herdr shares one layout between every attached client - MEASURED: the
     * first client redrew when a second joined. A key per pane would stack
     * identical clients on one daemon and reflow the operator's own window
     * once per click.
     */
    const a = herdrAttachSessionId(row({ paneId: 'w8:p1' }));
    const b = herdrAttachSessionId(row({ paneId: 'w2:p9' }));
    expect(a).toBe(b);
  });

  it('keeps two different herdr sessions apart', () => {
    // herdr can hold several, each its own socket and its own layout.
    expect(herdrAttachSessionId(row({ socketPath: '/a/herdr.sock' })))
      .not.toBe(herdrAttachSessionId(row({ socketPath: '/b/herdr.sock' })));
  });

  it('still produces a usable key when the socket is unknown', () => {
    // Unlike a READ, attaching without a named socket is safe: `herdr` with no
    // argument opens the default session, which is the one an operator has.
    expect(herdrAttachSessionId(row({ socketPath: '' }))).toBe('herdr:default');
  });
});

/* ── it is an attach, and says so in every field ───────────────────────── */

describe('the session it opens', () => {
  it('asks for the attach, not for an agent', () => {
    expect(herdrAttachSession(row(), AT).agentId).toBe(HERDR_AGENT_ID);
  });

  it('carries no branch, because it checks nothing out', () => {
    /*
     * An adopted session works in its own directory. Naming a branch here
     * would be the beginning of dragging somebody else's work into one of our
     * worktrees, which is exactly what attaching avoids.
     */
    expect(herdrAttachSession(row(), AT).branchName).toBeNull();
  });

  it('refuses auto-approve and persistence, rather than leaving them unset', () => {
    /*
     * Auto-approve appends flags to an agent we are not starting, and
     * persistence is the one thing herdr already guarantees. Stated, so a
     * default flipping somewhere else cannot reach an attach.
     */
    const s = herdrAttachSession(row(), AT);
    expect(s.autoApprove).toBe(false);
    expect(s.persist).toBe(false);
  });

  it('names the project, so the tab is not just "herdr"', () => {
    expect(herdrAttachSession(row(), AT).title).toContain('cglab-agentic-catalog');
  });

  it('falls back to the agent when the pane belongs to no project', () => {
    expect(herdrAttachSession(row({ projectName: '' }), AT).title).toContain('pi');
  });
});

/* ── the id the two packages must agree on ─────────────────────────────── */

describe('the attach id', () => {
  it('is the literal the desktop main process branches on', () => {
    /*
     * The renderer and the main process do not share a module, and the main
     * process uses this exact string to skip the worktree, the tmux wrapper
     * and the run registration. A rename on one side alone turns an attach
     * back into "spawn an agent called herdr in a worktree" - which would
     * fail on the resolver, in a place nobody would connect to a rename here.
     * The matching pin lives in packages/desktop/src/test/herdrAttach.test.ts.
     */
    expect(HERDR_AGENT_ID).toBe('herdr');
  });
});
