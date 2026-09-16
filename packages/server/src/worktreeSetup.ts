/**
 * Making a fresh worktree usable, without copying 939 MB into it (CGLAB-203).
 *
 * A new worktree has no `node_modules`, and in this repository that is 939 MB
 * against 8.1 MB of source. Three ways round it were measured, and the
 * measurement is what decides:
 *
 *   SYMLINK the directory - a trap in a workspace monorepo. `node_modules/
 *   @scope/pkg` is a RELATIVE symlink into `packages/`, so every `@scope/*`
 *   import resolves back to the PRIMARY checkout. The suite goes green having
 *   tested the wrong code, which is the worst failure available because it
 *   presents as success.
 *
 *   CLONE with copy-on-write - genuinely works where the filesystem has it
 *   (reproduced: the cloned tree resolves its relative link in-tree while the
 *   symlinked one resolves to the primary checkout). But it freezes worktree
 *   creation for minutes on any filesystem without CoW, so it cannot be the
 *   default.
 *
 *   INSTALL per worktree - simplest, portable, and carries neither trap. This
 *   is the one.
 *
 * `pnpm` does not rescue anybody here: its store links stay inside
 * `node_modules`, but a `workspace:*` link escapes exactly as npm's does.
 *
 * IT NEVER GUESSES THE COMMAND. A repository that declares no setup script
 * gets a worktree with no dependencies and is TOLD so. Inferring `npm ci` from
 * a lockfile would run for minutes and sometimes be wrong, and a wrong command
 * running for minutes is worse than none at all.
 */

export interface SetupDecision {
  /** The command to run in the new worktree, or null when none was declared. */
  readonly command: string | null;
  /** What to tell whoever made the worktree. Always present. */
  readonly notice: string;
  /**
   * True when the worktree is usable as it stands - no setup was needed rather
   * than none was found.
   */
  readonly ready: boolean;
}

export interface SetupInputs {
  /** What the repo declares, e.g. project.setupCommand. Absent is normal. */
  readonly declared?: string | null;
  /** Whether the repo has any dependency manifest at all. */
  readonly hasManifest: boolean;
}

/**
 * What to run in a newly created worktree.
 *
 * Returns a decision rather than running anything: the caller owns the shell,
 * and a module that both decides and executes cannot be tested without one.
 */
export function planWorktreeSetup({ declared, hasManifest }: SetupInputs): SetupDecision {
  const command = declared?.trim() ? declared.trim() : null;

  if (command) {
    /*
     * THE NOTICE SAYS WHAT TO DO, NOT WHAT IS HAPPENING. It read "Running the
     * project's setup command in the new worktree: npm ci" and NOTHING RAN IT -
     * the decision is returned to a caller that posts it as a comment. An agent
     * reading that starts work believing an install is under way, fails on an
     * import, and goes looking at its own change: the exact wrong afternoon
     * this module exists to prevent, now with a reassurance in front of it.
     * That is strictly worse than the undeclared case, which at least says the
     * dependencies are missing.
     *
     * Whether AgEnFK should run it is a separate decision with its own weight -
     * an arbitrary shell string, executed inside a status-change handler,
     * blocking for minutes - and is carded rather than assumed here. Until then
     * the honest thing is to say plainly that it is not run.
     */
    return {
      command,
      ready: false,
      notice:
        `This worktree has no dependencies installed yet. The project declares a setup command, `
        + `and AgEnFK does NOT run it for you - run it here before starting work:\n\n    ${command}`,
    };
  }

  if (!hasManifest) {
    /*
     * No manifest and no script is not a gap - there is nothing to install.
     * Saying "no setup declared" here would send somebody to write a script
     * for a repository that does not need one.
     */
    return {
      command: null,
      ready: true,
      notice: 'No dependencies to install: this repository declares no manifest.',
    };
  }

  /*
   * A manifest and no script. This is the case worth being explicit about: the
   * worktree is REAL and its dependencies are absent, and an agent that starts
   * work here will fail on an import rather than on anything it did.
   *
   * Deliberately no inference from the lockfile. `npm ci` is the obvious
   * guess, it takes minutes, and it is wrong for every repository that needs
   * a build step, a submodule, or a different package manager first.
   */
  return {
    command: null,
    ready: false,
    notice:
      'This worktree has no dependencies installed, and the project declares no setup command. '
      + 'Set one with `agenfk update-project <id> --setup-command "<cmd>"`, or install by hand '
      + 'before starting work here. Nothing is guessed: a wrong command running for minutes is '
      + 'worse than none.',
  };
}
