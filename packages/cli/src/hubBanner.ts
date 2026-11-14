import chalk from 'chalk';
import { indicatorHint, type DeadletterIndicator } from '@agenfk/core';

/**
 * Consecutive delivery failures before the startup banner warns. A halted
 * flusher warns immediately; this covers the stuck-but-not-halted case (moved
 * hub URL, proxy in the way) that used to be invisible. Three cycles is a
 * couple of minutes at the default 30s interval — long enough to ride out a
 * laptop waking up, short enough to notice before the outbox grows.
 */
export const STUCK_FAILURE_THRESHOLD = 3;

/**
 * The pre-action hub warnings, from the local server's /internal/hub/status
 * reply. Delivery problems (halted, stuck) and refusals are different problems
 * and both can hold at once, so each gets its own line.
 *
 * Refusals key off the deadletter indicator, not lastError: the flusher clears
 * lastError on its next flush, which is how a machine reported into a black
 * hole for three days (#223). The indicator clears only when the deadletter
 * file is emptied.
 */
export function hubBannerMessages(status: any): string[] {
  const out: string[] = [];
  if (!status || typeof status !== 'object') return out;
  if (status.halted) {
    out.push(chalk.yellow(
      `⚠ Hub flusher halted (last error: ${status.lastError ?? 'unknown'}). ` +
      `Run \`agenfk hub status\` for details, or \`agenfk hub login --url <hub>\` to re-authenticate — \n  that now takes effect immediately, without restarting the server.`
    ));
  } else if (Number(status.consecutiveFailures) >= STUCK_FAILURE_THRESHOLD) {
    // A hub that has moved, or a proxy in the way, no longer halts — it backs
    // off and retries forever. Without this the outbox would grow silently
    // while `agenfk hub status` reported a cheerful "Halted: no".
    out.push(chalk.yellow(
      `⚠ Hub events are not being delivered — ${status.consecutiveFailures} consecutive failures, ` +
      `${status.outboxDepth ?? '?'} queued (last error: ${status.lastError ?? 'unknown'}). ` +
      `Run \`agenfk hub status\`; if the hub moved, \`agenfk hub repoint --url <hub>\`.`
    ));
  }
  const dl = status.deadletter as DeadletterIndicator | undefined;
  if (dl && Number(dl.actionable) > 0) {
    out.push(chalk.yellow(
      `⚠ Hub refused ${dl.actionable} event(s) since ${dl.since ?? 'an unknown time'} — they are not on the hub. ` +
      (indicatorHint(dl) ?? '')
    ));
  }
  return out;
}
