// Pure helpers for the admin Query Console page — kept out of the component so
// they can be unit-tested without a DOM.

export const DEFAULT_ROW_LIMIT = 1000;
export const MAX_ROW_LIMIT = 5000;

/** Parse + clamp a user-supplied row limit into [1, MAX_ROW_LIMIT], falling
 *  back to the default for missing / non-numeric / non-positive input. */
export function clampRowLimit(
  value: number | string | undefined,
  def = DEFAULT_ROW_LIMIT,
  max = MAX_ROW_LIMIT,
): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Render a result-grid cell value as display text. NULL/undefined become the
 *  literal "NULL"; objects/arrays are JSON-encoded; everything else stringifies. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
