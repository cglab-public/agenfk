/**
 * @vitest-environment node
 *
 * Session persistence, and saying plainly when it is unavailable.
 *
 * A terminal we spawn is a child of this app: close the app and the agent dies
 * with it. tmux breaks that link — it runs as its own daemon and owns the
 * process, while our PTY is only a view attached to it. So the way to make a
 * session survive is not to build a supervisor, it is to delegate to one that
 * has existed for twenty years.
 *
 * Two things have to be honest about it:
 *
 *  - tmux is a native program, not something we can ship. It is frequently
 *    absent, so this has to be detected and the absence explained with the
 *    command that fixes it.
 *  - **tmux does not exist on Windows.** Not "is usually missing" — there is no
 *    port. The request must therefore degrade into a NAMED warning the UI can
 *    explain, never a silently-ignored flag. A toggle that appears to work and
 *    does nothing is the exact defect review caught in the auto-approve chain.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectTmux,
  buildTmuxShellCommand,
  tmuxSessionName,
  TMUX_UNSUPPORTED_ON_WINDOWS,
  TMUX_INSTALL_HINT,
} from '../main/tmux';

describe('detecting tmux', () => {
  it('reports it available when the binary is on PATH', async () => {
    const result = await detectTmux({ platform: 'darwin', which: async () => '/opt/homebrew/bin/tmux' });
    expect(result.available).toBe(true);
  });

  it('reports it missing, with the command that installs it', async () => {
    // "Not available" alone leaves the user stuck. The point of reporting it is
    // to say what to do.
    const result = await detectTmux({ platform: 'darwin', which: async () => null });
    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/brew install tmux/);
  });

  it('gives Linux its own install command, not homebrew', async () => {
    const result = await detectTmux({ platform: 'linux', which: async () => null });
    expect(result.hint).toMatch(/apt|dnf|pacman/i);
  });

  it('does not even probe on Windows', async () => {
    // There is no tmux for Windows. Probing would be a spawn that can only
    // fail, and reporting "not installed" would imply it could be.
    const which = vi.fn(async () => null);
    const result = await detectTmux({ platform: 'win32', which });
    expect(which).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
    expect(result.warning).toBe(TMUX_UNSUPPORTED_ON_WINDOWS);
  });

  it('distinguishes "you could install it" from "it cannot exist here"', async () => {
    // The difference the UI has to render. One is an action; the other is a
    // fact about the platform, and offering an install command for it would be
    // a lie.
    const missing = await detectTmux({ platform: 'darwin', which: async () => null });
    const impossible = await detectTmux({ platform: 'win32', which: async () => null });

    expect(missing.warning).toBeUndefined();
    expect(missing.hint).toBeTruthy();
    expect(impossible.warning).toBe(TMUX_UNSUPPORTED_ON_WINDOWS);
    expect(impossible.hint).toBeUndefined();
  });

  it('treats a failed probe as absent rather than throwing', async () => {
    const result = await detectTmux({
      platform: 'darwin',
      which: async () => { throw new Error('spawn failed'); },
    });
    expect(result.available).toBe(false);
  });

  it('publishes the install hint for the UI to show verbatim', () => {
    expect(TMUX_INSTALL_HINT.darwin).toMatch(/brew/);
    expect(TMUX_INSTALL_HINT.linux).toBeTruthy();
  });
});

describe('the session name', () => {
  it('is stable for the same card and agent', () => {
    expect(tmuxSessionName('item-1', 'claude-code')).toBe(tmuxSessionName('item-1', 'claude-code'));
  });

  it('differs per card, so two cards never share a session', () => {
    expect(tmuxSessionName('item-1', 'claude-code')).not.toBe(tmuxSessionName('item-2', 'claude-code'));
  });

  it('differs per agent on the same card', () => {
    expect(tmuxSessionName('item-1', 'claude-code')).not.toBe(tmuxSessionName('item-1', 'codex'));
  });

  it('fits tmux’s name limit', () => {
    // tmux truncates long names, and a truncated name is one that has-session
    // can no longer match — so the session is orphaned and a new one spawns
    // beside it every launch.
    const name = tmuxSessionName('a'.repeat(400), 'claude-code');
    expect(name.length).toBeLessThanOrEqual(48);
  });

  it('contains nothing that needs quoting', () => {
    // It is interpolated into a shell line. Anything exotic here is a quoting
    // bug waiting to happen, so the name is constrained at the source.
    expect(tmuxSessionName('weird id: $(rm -rf /) `x` ;', 'claude-code')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stays readable — a person has to recognise it in `tmux ls`', () => {
    expect(tmuxSessionName('item-1', 'claude-code')).toMatch(/agenfk/);
  });
});

describe('the shell line that attaches', () => {
  const line = () => buildTmuxShellCommand('agenfk-abc123', 'claude-code', []);

  it('attaches to an existing session instead of starting a second one', () => {
    expect(line()).toMatch(/has-session/);
    expect(line()).toMatch(/attach-session/);
  });

  it('matches the session name EXACTLY', () => {
    // Without `=`, tmux matches by PREFIX — so a session named `agenfk-ab`
    // would be attached for `agenfk-abc123`, putting the user in someone
    // else's card.
    expect(line()).toMatch(/-t '?=agenfk-abc123/);
  });

  it('keeps a long scrollback, which is the whole point of persisting', () => {
    expect(line()).toMatch(/history-limit \d{4,}/);
  });

  it('does not let a missing option break the chain', () => {
    // An older tmux that does not know an option must not take the attach down
    // with it.
    expect(line()).toMatch(/\|\| true/);
  });

  it('asks for UTF-8', () => {
    // Agent output is full of box drawing and emoji; without -u tmux mangles it.
    expect(line()).toMatch(/tmux -u/);
  });

  it('refuses a session name it did not generate', () => {
    // The name reaches a shell line. Accepting an arbitrary one would be a
    // command injection with extra steps.
    expect(() => buildTmuxShellCommand('a; rm -rf /', 'claude-code', [])).toThrow(/session name/i);
    expect(() => buildTmuxShellCommand('$(whoami)', 'claude-code', [])).toThrow(/session name/i);
    expect(() => buildTmuxShellCommand('', 'claude-code', [])).toThrow(/session name/i);
  });

  it('refuses an agent command it did not resolve', () => {
    expect(() => buildTmuxShellCommand('agenfk-abc123', 'rm -rf /', [])).toThrow(/unknown agent/i);
  });

  it('carries the agent’s own arguments through', () => {
    const withFlag = buildTmuxShellCommand('agenfk-abc123', 'claude-code', ['--dangerously-skip-permissions']);
    expect(withFlag).toMatch(/--dangerously-skip-permissions/);
  });
});
