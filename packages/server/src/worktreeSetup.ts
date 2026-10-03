/**
 * Making a fresh worktree usable, without copying a whole dependency tree into
 * it (CGLAB-203).
 *
 * A new worktree is a clean checkout and has NO dependencies, in any language.
 * The cost differs enormously by ecosystem - this repository is a Node
 * monorepo where it is 939 MB against 8.1 MB of source, while a .NET, Go or
 * Java project resolves from a machine-global cache in seconds - and the
 * decision below is deliberately per-project rather than per-language. Three
 * ways round it were measured, and the measurement is what decides (the
 * symlink trap is a Node/workspace one; the other two are general):
 *
 *   SYMLINK the directory - a trap in a workspace monorepo. `node_modules/
 *   @scope/pkg` is a RELATIVE symlink into `packages/`, so every `@scope/*`
 *   import resolves back to the PRIMARY checkout. The suite goes green having
 *   tested the wrong code, which is the worst failure available because it
 *   presents as success. Orca documents the same mechanism for `node_modules`
 *   (`worktree.sharedDirectories` is "symlink/share, not copy") - and their own
 *   repository does not use it.
 *
 *   CLONE with copy-on-write - genuinely works where the filesystem has it
 *   (reproduced: the cloned tree resolves its relative link in-tree while the
 *   symlinked one resolves to the primary checkout). But it freezes worktree
 *   creation for minutes on any filesystem without CoW, so it cannot be the
 *   default.
 *
 *   INSTALL per worktree - simplest, portable, and carries neither trap. This
 *   is the one, and it is what Orca actually does: their `orca.yaml` declares
 *   `scripts.setup` (a bootstrap script plus `pnpm install`) and it runs in
 *   every new worktree with `--setup run`. They pay the install.
 *
 * `pnpm` does not rescue anybody here: its store links stay inside
 * `node_modules`, but a `workspace:*` link escapes exactly as npm's does.
 *
 * IT NEVER GUESSES THE COMMAND. A repository that declares no setup script
 * gets a worktree with no dependencies and is TOLD so. Inferring `npm ci` from
 * a lockfile would run for minutes and sometimes be wrong, and a wrong command
 * running for minutes is worse than none at all.
 *
 * DECIDING IS NOT RUNNING. This module plans, and folds a run's outcome back
 * in; the CALLER owns the shell (712a4752). That separation is deliberate: the
 * command must not be executed inside the status transition that creates the
 * worktree, because it takes minutes and would hold the server's event loop -
 * the same rule that makes `verify` run in the background.
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

/**
 * How long a setup command may run before it is killed.
 *
 * Ten minutes: a cold dependency restore on a large tree takes minutes, and a
 * hang must not leave one running forever. The COMMAND is per-project; this cap
 * is a ceiling no legitimate restore of any ecosystem is expected to reach (a
 * Go or .NET restore finishes in seconds).
 */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export interface SetupRun {
  readonly ok: boolean;
  readonly output: string;
  readonly timedOut: boolean;
}

export interface SetupInputs {
  /** What the repo declares, e.g. project.setupCommand. Absent is normal. */
  readonly declared?: string | null;
  /** Whether the repo has any dependency manifest at all. */
  readonly hasManifest: boolean;
  /**
   * True when the worktree already existed and was adopted.
   *
   * Only the WORDING changes: an adopted worktree is never re-installed, and
   * whether its dependencies are present is a fact about the directory that
   * this cannot see. Saying "AgEnFK does NOT run it" after a previous run
   * installed them is the module's own failure mode - a confident wrong answer.
   */
  readonly reused?: boolean;
}

export function planWorktreeSetup({ declared, hasManifest, reused }: SetupInputs): SetupDecision {
  const command = declared?.trim() ? declared.trim() : null;

  if (command) {
    if (reused) {
      return {
        command,
        ready: false,
        notice:
          'This worktree already existed and was adopted. AgEnFK installs on creation only, '
          + `so it was not re-installed here - check before starting work:\n\n    ${command}`,
      };
    }
    /*
     * NEUTRAL ABOUT WHO RUNS IT. A decision cannot know: the caller may be the
     * token-gated path that starts the install in the background, or one of the
     * several that only record the worktree. Promising an install here made the
     * un-tokened paths lie - the exact defect this module exists to prevent.
     * `applySetupResult` is what says it ran; until then this states the fact.
     */
    return {
      command,
      ready: false,
      notice:
        'This worktree has no dependencies installed yet. The project declares a setup command, '
        + `which has to run here before work starts:\n\n    ${command}`,
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
   * Deliberately no inference from a lockfile: there is no command that is
   * right across ecosystems. `npm ci`, `dotnet restore`, `go mod download`,
   * `mvn`, `bundle install` are all plausible, each is wrong for repositories
   * that need a build step or a submodule first, and guessing wrong costs
   * minutes, whatever the language.
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

/**
 * Fold a setup run's outcome into the decision (712a4752).
 *
 * PURE, and separated from the running of it on purpose: the caller owns the
 * shell, and the caller is where the event loop must not be blocked. What a
 * success or failure MEANS, and what the card is told, is this function.
 */
export function applySetupResult(
  decision: SetupDecision,
  result: SetupRun,
  timeoutMs: number = SETUP_TIMEOUT_MS,
): SetupDecision {
  if (!decision.command) return decision;
  if (result.ok) {
    return { ...decision, ready: true, notice: `Dependencies installed in this worktree with:\n\n    ${decision.command}` };
  }
  const why = result.timedOut
    ? `did not finish within ${Math.round(timeoutMs / 60_000)} minutes`
    : 'failed';
  return {
    ...decision,
    ready: false,
    notice:
      `The setup command ${why} in this worktree, so its dependencies are NOT installed. `
      + `Run it here and read the output before starting work:\n\n    ${decision.command}\n\n`
      + result.output.trim().slice(-2000),
  };
}
