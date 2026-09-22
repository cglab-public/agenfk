/**
 * What a project is configured with, and where each value came from.
 *
 * THE DEFECT THIS ANSWERS: half of a project's configuration is inferred, and
 * an inferred value that is wrong is invisible. Four projects on this machine
 * have `projectRoot` pointing at $HOME — which would cut a worktree from the
 * user's home directory — and no screen in the product says so.
 *
 * Provenance is computed here rather than in the screen because it is not a
 * presentation detail: whether a value was set, inherited or merely guessed is
 * a fact about the data, and the same answer belongs to the CLI the day it
 * prints this.
 */
import { describe, it, expect } from 'vitest';
import { describeProjectSettings } from '../projectSettings';

const project = {
  id: 'p1', name: 'horizon-ds',
  projectRoot: '/Users/me/GitHub/horizon-ds',
  verifyCommand: 'npm test',
  autoWorktree: true,
  flowId: undefined,
} as never;

const row = (rows: ReturnType<typeof describeProjectSettings>, key: string) =>
  rows.find(r => r.key === key)!;

describe('what each row says about itself', () => {
  const rows = describeProjectSettings(project, { flowName: null, worktreeRoot: '~/.agenfk-worktrees' });

  it('marks the one field this screen actually owns', () => {
    // Today that is autoWorktree, and nothing else. A screen claiming more
    // would be offering edits the server refuses.
    expect(row(rows, 'autoWorktree').origin).toBe('set-here');
  });

  it('marks a fallback as inherited, and names what it fell back to', () => {
    const flow = row(rows, 'flow');
    expect(flow.origin).toBe('inherited');
    expect(flow.from).toMatch(/default/i);
  });

  it('marks the shell strings as CLI-only, with the command that sets them', () => {
    // They are shell strings this machine later runs. A field here would hand
    // an unauthenticated caller the choice of what executes.
    for (const key of ['verifyCommand', 'setupCommand']) {
      expect(row(rows, key).origin).toBe('cli-only');
      expect(row(rows, key).how).toMatch(/agenfk update-project/);
    }
  });

  it('marks the folder as main-only, because it is a working directory', () => {
    expect(row(rows, 'projectRoot').origin).toBe('main-only');
  });
});

describe('the values people need to see', () => {
  it('says when a command is missing, rather than showing an empty row', () => {
    const rows = describeProjectSettings(project, { flowName: null, worktreeRoot: '~/.agenfk-worktrees' });
    const setup = row(rows, 'setupCommand');
    expect(setup.value).toBeNull();
    // The consequence, not the absence: "not set" tells nobody what it costs.
    expect(setup.warning).toMatch(/dependencies/i);
  });

  it('warns when the folder is the home directory', () => {
    /*
     * The case that made this screen worth building. A project rooted at $HOME
     * cuts worktrees from the user's home directory and commits there on close.
     */
    const rows = describeProjectSettings(
      { ...(project as any), projectRoot: '/Users/me' } as never,
      { flowName: null, worktreeRoot: '~/.agenfk-worktrees', homeDir: '/Users/me' },
    );
    expect(row(rows, 'projectRoot').warning).toMatch(/home directory/i);
  });

  it('warns when there is no folder at all', () => {
    const rows = describeProjectSettings(
      { ...(project as any), projectRoot: undefined } as never,
      { flowName: null, worktreeRoot: '~/.agenfk-worktrees' },
    );
    const root = row(rows, 'projectRoot');
    expect(root.value).toBeNull();
    expect(root.warning).toMatch(/nowhere to run/i);
  });

  it('shows where this project’s worktrees actually go, not just the root', () => {
    const rows = describeProjectSettings(project, { flowName: null, worktreeRoot: '/wt' });
    expect(row(rows, 'worktreeRoot').value).toBe('/wt');
    expect(row(rows, 'worktreeRoot').from).toContain('/wt/horizon-ds');
  });

  it('names the chosen flow when there is one', () => {
    const rows = describeProjectSettings(
      { ...(project as any), flowId: 'f1' } as never,
      { flowName: 'TDD Flow', worktreeRoot: '/wt' },
    );
    expect(row(rows, 'flow').value).toBe('TDD Flow');
    expect(row(rows, 'flow').origin).toBe('set-here');
  });
});

describe('what it never does', () => {
  it('returns every row even when the project is bare', () => {
    // A hidden row is how an unset value stays unset. Rows are the checklist.
    const rows = describeProjectSettings({ id: 'p', name: 'bare' } as never, { flowName: null, worktreeRoot: '/wt' });
    expect(rows.map(r => r.key).sort()).toEqual(
      ['autoWorktree', 'flow', 'projectRoot', 'setupCommand', 'verifyCommand', 'worktreeRoot'].sort(),
    );
  });

  it('carries no secret and no token', () => {
    const rows = describeProjectSettings(project, { flowName: null, worktreeRoot: '/wt' });
    expect(JSON.stringify(rows)).not.toMatch(/token|secret|password/i);
  });
});
