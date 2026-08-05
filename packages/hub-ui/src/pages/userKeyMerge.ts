/**
 * Helpers for the admin → Merge identities UI.
 *
 * Pure logic so the existing hub-ui test convention (no RTL) keeps working.
 *
 * Context: `user_key` is minted at ingest from the reporting client's git
 * identity, so one person shows up as several rows when their git config is
 * wrong (a literal `=` from `git config user.email = "x"`, or the OS username
 * when git email is unset). This screen folds those rows into the real one.
 *
 * Normalization and the source cap MUST stay in lockstep with
 * packages/hub/src/routes/userKeyMerge.ts — the server is the source of truth,
 * but validating here saves a round-trip and lets us disable the button with an
 * inline reason instead of surfacing a 400.
 */

/** Mirrors MAX_SOURCES in the server route. */
export const MAX_MERGE_SOURCES = 50;

/** Mirrors normalizeKey() in the server route. */
export function normalizeUserKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export interface UserKeyRow {
  user_key: string;
  events_count?: number | string;
}

/**
 * Source keys the request will actually carry: normalized, deduped, and with
 * the target removed. Merging a key into itself is a no-op rather than an
 * error, so it is filtered here exactly as the server filters it.
 */
export function deriveMergeSources(selected: readonly string[], target: string): string[] {
  const to = normalizeUserKey(target);
  return [...new Set(selected.map(normalizeUserKey).filter((k) => k && k !== to))];
}

/**
 * Inline validation message, or null when the merge is submittable. Ordered so
 * the message names the first thing the operator has to fix.
 */
export function validateMerge(selected: readonly string[], target: string): string | null {
  if (!normalizeUserKey(target)) return 'Choose the identity to keep.';
  const sources = deriveMergeSources(selected, target);
  if (sources.length === 0) return 'Select at least one other identity to merge in.';
  if (sources.length > MAX_MERGE_SOURCES) {
    return `Select at most ${MAX_MERGE_SOURCES} identities to merge (selected ${sources.length}).`;
  }
  return null;
}

/** Rows offered as merge sources: everything except the chosen target. */
export function mergeSourceCandidates<T extends UserKeyRow>(rows: readonly T[], target: string): T[] {
  const to = normalizeUserKey(target);
  return rows.filter((r) => normalizeUserKey(r.user_key) !== to);
}

/**
 * Confirmation copy. The merge is not reversible — once events are repointed
 * the hub has no record of which identity they arrived under — so the operator
 * gets told that in the same breath as the counts.
 */
export function mergeConfirmMessage(selected: readonly string[], target: string): string {
  const sources = deriveMergeSources(selected, target);
  const to = normalizeUserKey(target);
  const what = sources.length === 1 ? '1 identity' : `${sources.length} identities`;
  return `Merge ${what} into ${to}? Their events, daily rollups and installations `
    + 'will be credited to it. This cannot be undone.';
}

export interface MergeResultLike {
  events?: number;
  rollupsRemoved?: number;
  installations?: number;
  hiddenRemoved?: number;
}

/**
 * Success banner text. `events: 0` is a real and unalarming outcome — it means
 * the keys were already merged (the endpoint is idempotent) — so it is reported
 * plainly rather than styled as a failure.
 */
export function formatMergeResult(to: string, r: MergeResultLike): string {
  const events = r.events ?? 0;
  const parts = [`${events} event${events === 1 ? '' : 's'} now credited to ${normalizeUserKey(to)}`];
  if (r.rollupsRemoved) parts.push(`${r.rollupsRemoved} daily rollup row(s) folded in`);
  if (r.installations) parts.push(`${r.installations} installation(s) relabelled`);
  if (r.hiddenRemoved) parts.push(`${r.hiddenRemoved} stale hide(s) cleared`);
  return events === 0
    ? `Nothing to move — those identities were already merged into ${normalizeUserKey(to)}.`
    : `${parts.join('; ')}.`;
}
