/**
 * What a project is configured with, and where each value came from.
 *
 * THE DEFECT THIS ANSWERS: half of a project's configuration is inferred, and
 * an inferred value that is wrong is invisible. Four projects on this machine
 * have `projectRoot` pointing at the user's home directory — which cuts
 * worktrees from $HOME and commits there on close — and no screen says so.
 *
 * Provenance lives here rather than in the screen because it is not a
 * presentation detail: whether a value was set, inherited, or merely guessed
 * is a fact about the data. The CLI can print the same answer the day it wants
 * to.
 */
import type { Project } from './types';

/**
 * Where a value came from, and therefore what can be done about it.
 *
 * `cli-only` and `main-only` are not limitations to apologise for: a shell
 * string this machine later runs, and a working directory it runs things in,
 * must not be settable by an unauthenticated caller. The row still appears —
 * hiding what cannot be edited here is exactly how an inferred value stays
 * wrong for four projects.
 */
export type SettingOrigin = 'set-here' | 'inherited' | 'inferred' | 'cli-only' | 'main-only';

export interface ProjectSettingRow {
  key: string;
  label: string;
  /** What it is for, in one line, from the user's side of the screen. */
  description: string;
  value: string | null;
  origin: SettingOrigin;
  /** Where the value came from, spelled out. */
  from: string;
  /** The command that changes it, when this screen cannot. */
  how?: string;
  /** What it costs to leave it as it is. */
  warning?: string;
}

export interface ProjectSettingsContext {
  /** The name of the flow this project uses, or null when it inherits one. */
  flowName: string | null;
  /** Where worktrees are cut, before the project's own folder is appended. */
  worktreeRoot: string;
  /** Used only to recognise a project rooted at the home directory. */
  homeDir?: string;
}

export function describeProjectSettings(
  project: Project,
  ctx: ProjectSettingsContext,
): ProjectSettingRow[] {
  const root = project.projectRoot?.replace(/\/+$/, '') || null;
  const home = ctx.homeDir?.replace(/\/+$/, '');

  return [
    {
      key: 'projectRoot',
      label: 'Project folder',
      description: 'Where agents run, where the close commit is made, and where worktrees are cut from.',
      value: root,
      origin: 'main-only',
      from: root ? 'Set when the project was added.' : 'Never set.',
      how: 'agenfk update-project <id> — the browser may not set a working directory.',
      warning: !root
        ? 'No folder, so an agent has nowhere to run and no worktree can be cut.'
        : home && root === home
          ? 'This is your home directory. Worktrees would be cut from it and the close commit made there.'
          : undefined,
    },
    {
      key: 'flow',
      label: 'Flow',
      description: 'The steps a card moves through, and what each one demands before it may advance.',
      value: ctx.flowName,
      origin: project.flowId ? 'set-here' : 'inherited',
      from: project.flowId ? 'Chosen for this project.' : 'From the default flow — this project has not chosen one.',
    },
    {
      key: 'worktreeRoot',
      label: 'Worktree root',
      description: 'Where a card’s worktree is cut when it starts.',
      value: ctx.worktreeRoot,
      origin: 'inherited',
      // The root alone answers the wrong question: what a person wants to know
      // is where THIS project's worktrees land.
      from: `Worktrees for this project go in ${ctx.worktreeRoot}/${project.name}/<card> — from the built-in default.`,
    },
    {
      key: 'verifyCommand',
      label: 'Verify command',
      description: 'Run before a card may reach the last step. Without one, that move is refused.',
      value: project.verifyCommand ?? null,
      origin: 'cli-only',
      from: project.verifyCommand ? 'Set for this project.' : 'Not set.',
      how: 'agenfk update-project <id> --verify-command "<cmd>"',
      warning: project.verifyCommand ? undefined : 'Without one, a card cannot reach the last step at all.',
    },
    {
      key: 'setupCommand',
      label: 'Setup command',
      description: 'Run once in a fresh worktree. Never guessed — a wrong guess runs for minutes.',
      value: project.setupCommand ?? null,
      origin: 'cli-only',
      from: project.setupCommand ? 'Set for this project.' : 'Not set.',
      how: 'agenfk update-project <id> --setup-command "<cmd>"',
      warning: project.setupCommand ? undefined : 'A new worktree starts with no dependencies installed.',
    },
    {
      key: 'autoWorktree',
      label: 'A worktree per card',
      description: 'Cut a worktree when a card starts. Off means every card shares this checkout.',
      value: project.autoWorktree === false ? 'Off' : 'On',
      origin: 'set-here',
      from: 'The one thing on this page the screen itself owns.',
    },
  ];
}
