/**
 * Attaching to herdr from the terminal this app already has.
 *
 * The feature these tests cover replaced a bespoke mirror. The point they
 * defend is that there is nothing bespoke left: a shell line, in a PTY, exactly
 * as tmux.ts has done all along.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHerdrAttachCommand,
  envWithoutHerdr,
  HERDR_SECOND_CLIENT_NOTE,
} from '../main/herdrAttach.js';
import { HERDR_AGENT_ID, AGENT_IDS } from '../main/agents.js';

describe('the attach line', () => {
  it('is just `herdr` for the session an operator already has open', () => {
    // No ensure step, unlike tmux: the daemon is already up holding the panes.
    expect(buildHerdrAttachCommand()).toBe('herdr');
  });

  it('names a session when asked for one', () => {
    expect(buildHerdrAttachCommand('agenfk-work')).toBe("herdr --session 'agenfk-work'");
  });

  it('REFUSES a name it did not generate, rather than escaping it', () => {
    /*
     * This string reaches a shell. Quoting an arbitrary name is command
     * injection with extra steps - the same posture tmux.ts takes, and for the
     * same reason.
     */
    for (const bad of ['a b', 'x;rm -rf /', '$(id)', '`id`', 'a/b', '']) {
      expect(() => buildHerdrAttachCommand(bad)).toThrow(/Refusing/);
    }
  });
});

describe('the environment', () => {
  it('strips every HERDR variable', () => {
    /*
     * MEASURED: herdr spawned from inside a pane answers "nested herdr is
     * disabled by default" and exits. An app launched from a herdr pane
     * inherits these, so a terminal opened from it would die on startup with
     * a message nobody would connect to the cause.
     */
    const out = envWithoutHerdr({
      HERDR_PANE_ID: 'w8:p1',
      HERDR_SOCKET_PATH: '/x/herdr.sock',
      HERDR_WORKSPACE_ID: 'w8',
      HERDR_TAB_ID: 't1',
      HERDR_ENV: '1',
      HERDR_AUTOSTARTED: '1',
      PATH: '/usr/bin',
      HOME: '/home/me',
    });
    expect(Object.keys(out).sort()).toEqual(['HOME', 'PATH']);
  });

  it('keeps everything else untouched, PATH above all', () => {
    // The login-shell PATH capture exists precisely so a spawned process can
    // find its executable; dropping it here would undo that work silently.
    const out = envWithoutHerdr({ PATH: '/opt/homebrew/bin:/usr/bin', TERM: 'xterm-256color' });
    expect(out.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(out.TERM).toBe('xterm-256color');
  });

  it('is case-insensitive, because an env var is not case-safe everywhere', () => {
    expect(Object.keys(envWithoutHerdr({ herdr_pane_id: 'x', Herdr_Env: '1', PATH: '/b' })))
      .toEqual(['PATH']);
  });

  it('does not strip a variable that merely mentions herdr later', () => {
    // MY_HERDR_THING is not herdr's. Only the prefix is theirs.
    expect(envWithoutHerdr({ MY_HERDR_THING: 'x', PATH: '/b' }).MY_HERDR_THING).toBe('x');
  });
});

describe('what the UI must say before opening one', () => {
  it('warns that a second client reshapes the layout', () => {
    /*
     * MEASURED on a throwaway session: the second client is accepted and the
     * first redrew when it joined. The grid is per session, not per client.
     * An operator with a full-screen herdr and twenty-four panes deserves to
     * know that before a narrow panel clamps it.
     */
    expect(HERDR_SECOND_CLIENT_NOTE).toMatch(/resize/i);
    expect(HERDR_SECOND_CLIENT_NOTE).toMatch(/already have open/i);
  });
});

/* ── the id, and where it must NOT appear ──────────────────────────────── */

describe('the attach id', () => {
  it('is the literal the renderer sends', () => {
    /*
     * The renderer and this process do not share a module. This string is what
     * the spawn path branches on to skip the worktree, the tmux wrapper and
     * the run registration; renamed on one side alone, an attach becomes
     * "spawn an agent called herdr in a worktree" and fails on the resolver,
     * somewhere nobody would connect to a rename. The matching pin lives in
     * packages/ui/src/test/herdrAttachSession.test.ts.
     */
    expect(HERDR_AGENT_ID).toBe('herdr');
  });

  it('is NOT in the agent picker', () => {
    /*
     * `AGENTS` is the picker's contents, and a sibling test in this package
     * refuses any entry there without a rules bundle - correctly. Offering
     * herdr beside Claude Code invites somebody to pick it for a card and get
     * a multiplexer instead of an agent. It is a closed set of one, checked by
     * equality, not a row in that table.
     */
    expect(AGENT_IDS).not.toContain(HERDR_AGENT_ID);
  });
});
