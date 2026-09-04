/**
 * Admin → Models → Provider & license section (CGLAB-133 follow-up).
 *
 * The hub stores `model` as free text an agent self-reports and has no provider
 * or license column, so the PR Overview's Provider / Open-weights / Commercial
 * facets come from the `model_meta` table. That table seeds itself from a
 * curated list on first read; this section is how an admin corrects it, because
 * a wrong classification on a dashboard is worse than none.
 *
 * Pure helpers here so the rules are testable without a DOM.
 */

export interface ModelMetaRow {
  model: string;
  provider: string;
  licenseClass: 'open_weights' | 'commercial';
  license: string;
  /** 'seed' = auto-inserted and untouched; 'admin' = human-set. */
  source: 'seed' | 'admin';
}

export const LICENSE_CLASSES = [
  { value: 'open_weights', label: 'Open weights' },
  { value: 'commercial', label: 'Commercial / API only' },
] as const;

export type LicenseClassValue = (typeof LICENSE_CLASSES)[number]['value'];

const MAX_LEN = 200;

/**
 * Validate a meta row before sending. Mirrors the server's checks so the admin
 * gets an inline message instead of a failed request, but the server remains
 * authoritative — a mismatch here fails closed, not open.
 */
export function validateMetaRow(input: {
  model: string; provider: string; license: string; licenseClass: string;
}): string | null {
  const model = input.model.trim();
  const provider = input.provider.trim();
  const license = input.license.trim();

  if (!model) return 'Model is required.';
  if (model.length > MAX_LEN) return `Model must be at most ${MAX_LEN} characters.`;
  if (!provider) return 'Provider is required — an empty provider renders an empty filter chip.';
  if (provider.length > MAX_LEN) return `Provider must be at most ${MAX_LEN} characters.`;
  if (!license) return 'License is required — name the actual licence, e.g. "MIT" or "Proprietary (API only)".';
  if (license.length > MAX_LEN) return `License must be at most ${MAX_LEN} characters.`;
  if (!LICENSE_CLASSES.some(c => c.value === input.licenseClass)) {
    return 'Choose either "Open weights" or "Commercial / API only".';
  }
  return null;
}

/**
 * Agent runtimes are not models. The server refuses these rows and the
 * resolver refuses to match them, so the form says so before a wasted request.
 */
const HARNESS_NAMES = new Set([
  'claude-code', 'claude-code-cli', 'codex-cli', 'opencode', 'cursor',
  'windsurf', 'aider', 'pi', 'openclaw', 'gemini-cli', 'copilot-cli',
]);

export function isHarnessName(model: string): boolean {
  return HARNESS_NAMES.has(model.trim().toLowerCase());
}

/**
 * Rows to show, sorted for a settings table rather than for a chart.
 *
 * Admin rows come first: they are the ones under active review, and after a
 * seed insert the table is ~100 rows, so burying the three the admin actually
 * touched at the alphabetical middle makes the page hard to verify at a glance.
 */
export function sortMetaRows(rows: ModelMetaRow[]): ModelMetaRow[] {
  return [...rows].sort((a, b) =>
    (a.source === 'admin' ? 0 : 1) - (b.source === 'admin' ? 0 : 1)
    || a.model.localeCompare(b.model));
}

/** Case-insensitive substring filter over model, provider and licence. */
export function filterMetaRows(rows: ModelMetaRow[], query: string): ModelMetaRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r =>
    r.model.toLowerCase().includes(q)
    || r.provider.toLowerCase().includes(q)
    || r.license.toLowerCase().includes(q));
}

export function licenseClassLabel(v: string): string {
  return LICENSE_CLASSES.find(c => c.value === v)?.label ?? v;
}
