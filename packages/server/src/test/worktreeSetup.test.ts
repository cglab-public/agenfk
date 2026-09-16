/**
 * A fresh worktree without 939 MB copied into it (CGLAB-203).
 *
 * THE FAILURE THIS AVOIDS IS THE ONE THAT LOOKS LIKE SUCCESS. Symlinking
 * `node_modules` across worktrees is the obvious saving and, in a workspace
 * monorepo, a trap: the `@scope/*` links inside it are RELATIVE, so every
 * import resolves back to the primary checkout and the suite passes having
 * tested the wrong code. Installing per worktree is slower and carries neither
 * that trap nor the copy.
 *
 * THE SECOND FAILURE IS GUESSING. `npm ci` is the obvious inference from a
 * lockfile; it runs for minutes and is wrong for any repo that needs a build
 * step, a submodule, or a different package manager first. A wrong command
 * running for minutes is worse than none at all.
 */
import { describe, it, expect } from 'vitest';
import { planWorktreeSetup } from '../worktreeSetup';

describe('when the project says what to run', () => {
  it('runs exactly that, and says so', () => {
    const d = planWorktreeSetup({ declared: 'pnpm install --frozen-lockfile', hasManifest: true });
    expect(d.command).toBe('pnpm install --frozen-lockfile');
    expect(d.notice).toContain('pnpm install --frozen-lockfile');
  });

  it('is not "ready", because the work has not happened yet', () => {
    // `ready` means usable as it stands. A command still to run is the
    // opposite, and conflating the two would let a caller skip it.
    expect(planWorktreeSetup({ declared: 'npm ci', hasManifest: true }).ready).toBe(false);
  });

  it('ignores whitespace-only declarations', () => {
    // A blank setting is how somebody clears one, and running "" would be an
    // empty shell invocation whose failure explains nothing.
    const d = planWorktreeSetup({ declared: '   ', hasManifest: true });
    expect(d.command).toBeNull();
  });
});

describe('when there is nothing to install', () => {
  it('says the worktree is ready, rather than reporting a missing script', () => {
    /*
     * No manifest and no script is not a gap. "No setup declared" here sends
     * somebody to write a script for a repository that does not need one.
     */
    const d = planWorktreeSetup({ hasManifest: false });
    expect(d.ready).toBe(true);
    expect(d.notice).toMatch(/no dependencies to install/i);
    expect(d.notice, 'reported an absence as a problem').not.toMatch(/declares no setup command/i);
  });
});

describe('when there is a manifest and no script', () => {
  it('never guesses a command', () => {
    /*
     * THE test. `npm ci` from a lockfile is the obvious inference and the
     * expensive one: minutes of running, wrong for any repo needing a build
     * step or another package manager first.
     */
    const d = planWorktreeSetup({ hasManifest: true });
    expect(d.command, 'it inferred an install command').toBeNull();
    expect(d.notice).not.toMatch(/npm ci|yarn|pnpm install/i);
  });

  it('says the worktree is NOT ready, so nobody starts work in it blind', () => {
    /*
     * The worktree is real and its dependencies are absent. An agent that
     * starts here fails on an import and goes looking at its own change, which
     * is the wrong afternoon.
     */
    const d = planWorktreeSetup({ hasManifest: true });
    expect(d.ready).toBe(false);
    expect(d.notice).toMatch(/no dependencies installed/i);
  });

  it('says how to fix it, naming the command that sets the command', () => {
    // A notice that states the problem and not the move is one people read
    // twice and act on never.
    expect(planWorktreeSetup({ hasManifest: true }).notice).toMatch(/--setup-command/);
  });

  it('says why nothing is guessed, so the silence is not read as a bug', () => {
    expect(planWorktreeSetup({ hasManifest: true }).notice).toMatch(/nothing is guessed/i);
  });
});

describe('the shape of every answer', () => {
  it('always carries a notice, whatever it decided', () => {
    // A silent decision about the worktree you are about to work in is the one
    // thing this module must never produce.
    for (const input of [
      { declared: 'x', hasManifest: true },
      { hasManifest: true },
      { hasManifest: false },
      { declared: null, hasManifest: false },
    ]) {
      expect(planWorktreeSetup(input).notice.length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });

  it('only reports ready when there is genuinely nothing left to do', () => {
    // ready === true must mean "use it now". Anything looser and a caller
    // skips a setup that was needed.
    expect(planWorktreeSetup({ hasManifest: false }).ready).toBe(true);
    expect(planWorktreeSetup({ hasManifest: true }).ready).toBe(false);
    expect(planWorktreeSetup({ declared: 'npm ci', hasManifest: true }).ready).toBe(false);
  });
});
