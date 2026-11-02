/**
 * Facts about a project's verify and setup commands that more than one
 * package states: the error the server refuses a final verify with when the
 * project has no verify command, and the `agenfk update-project` flags that
 * set the two commands.
 *
 * Defined once so the server's refusal, the CLI's options and the board's
 * create-project notice cannot drift apart. The board cannot import core at
 * runtime (see packages/ui/src/versionCompare.ts), so its copy of the words is
 * pinned against these by NewProjectForm.test.tsx.
 */

/** The error code a final-step verify is refused with when no verify command is set. */
export const NO_VERIFY_COMMAND = 'NO_VERIFY_COMMAND' as const;

/** `agenfk update-project` flag that sets the project's verify command. */
export const VERIFY_COMMAND_FLAG = '--verify-command' as const;

/** `agenfk update-project` flag that sets the command run in a newly cut worktree. */
export const SETUP_COMMAND_FLAG = '--setup-command' as const;
