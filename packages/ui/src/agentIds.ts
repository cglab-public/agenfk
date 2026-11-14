/**
 * Agent ids the UI names but that are NOT in the picker.
 *
 * `herdr` is an attach and lives in `herdrTreeRows.ts`; `shell` is the user's
 * own shell with no card and no project. Both are checked by equality at the
 * desktop's spawn border, which skips the worktree, the card prompt, tmux and
 * the run registration for them.
 *
 * Kept as a literal rather than imported from the desktop package: the
 * renderer and the main process share no module, so each side pins the string
 * with a test (see `herdrTreeRows.ts` for the same reasoning about `herdr`).
 */
export const SHELL_AGENT_ID = 'shell';