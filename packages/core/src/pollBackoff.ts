/**
 * cc5e4943: how long a client waits before polling a background verify run
 * again. A flat 1500ms made every background verify take >= 1.6s - a 0.6s
 * suite, or nothing run at all. The first wait is short and each next one
 * doubles, up to `cap` (the old interval), so a quick verify answers in a
 * fraction of a second and a long one is not polled harder. Shared by the CLI
 * (`agenfk verify`) and the MCP server (`validate_progress`).
 */
export const FIRST_POLL_DELAY_MS = 100;
export const POLL_CAP_MS = 1500;

/** The wait before the next poll: `previous` undefined for the first one. */
export function nextPollDelay(previous: number | undefined, cap: number = POLL_CAP_MS): number {
  return previous === undefined ? Math.min(FIRST_POLL_DELAY_MS, cap) : Math.min(previous * 2, cap);
}
