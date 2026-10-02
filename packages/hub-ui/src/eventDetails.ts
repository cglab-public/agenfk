// What an expanded event on the user page shows: the fields that matter as a
// label/value list, links where the hub knows where a thing lives, and the
// remaining scalar fields with readable labels. The raw JSON stays one toggle
// away (story ce9b0e8e).

export interface EventField { label: string; value: string; href?: string }

export interface EventRowLike {
  type: string;
  item_id: string | null;
  item_title: string | null;
  item_type: string | null;
  external_id: string | null;
  remote_url: string | null;
  pr_url?: string | null;
  /** The stored event: `externalUrl` at its top level (sent by the spoke beside
   *  externalId), and its own `payload` holding the type-specific fields. */
  payload: { externalUrl?: unknown; payload?: Record<string, unknown> } | null;
}

/** Fields shown by name below, so the generic pass skips them. */
const HANDLED = new Set([
  'prNumber', 'repo', 'model', 'harness', 'sizing', 'sizingShadow', 'leafStory',
  'fromStatus', 'toStatus', 'stayedOn', 'externalId', 'externalUrl',
  'checks', 'changedFields', 'argv', 'flow',
  // Already on the row: the title in Item, the type as a chip.
  'title', 'itemType',
]);
const MAX_EXTRA = 12;
/** A long comment or evidence stays readable; the raw JSON has the rest. */
const MAX_TEXT = 500;
const cap = (v: string) => (v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);

/** Only an absolute https URL is ever a link: these come from any
 *  installation's events. */
const httpsUrl = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch { return undefined; }
};

/** "customNote" → "Custom note", "check_name" → "Check name". */
const humanise = (key: string): string => {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const PLURAL: Record<string, string> = { epic: 'epics', story: 'stories', task: 'tasks', bug: 'bugs' };
const sizeText = (sizing: unknown): string | null => {
  if (!sizing || typeof sizing !== 'object') return null;
  const parts = (['epic', 'story', 'task', 'bug'] as const)
    .map(k => [k, Number((sizing as Record<string, unknown>)[k] ?? 0)] as const)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? k : PLURAL[k]}`);
  return parts.length ? parts.join(' · ') : null;
};

export function eventFields(e: EventRowLike): EventField[] {
  const p = (e.payload?.payload ?? {}) as Record<string, unknown>;
  const out: EventField[] = [];

  if (e.item_title || e.item_id) {
    out.push({ label: 'Item', value: e.item_title && e.item_id ? `${e.item_title} (${e.item_id})` : (e.item_title ?? e.item_id)! });
  }
  // The row shows a friendly badge and a shortened repo (hidden on phones);
  // their raw values were only in titles.
  out.push({ label: 'Type', value: e.type });
  if (e.remote_url) out.push({ label: 'Repository', value: e.remote_url });
  if (e.external_id) {
    const href = httpsUrl(e.payload?.externalUrl);
    out.push(href ? { label: 'Tracker', value: e.external_id, href } : { label: 'Tracker', value: e.external_id });
  }
  if (typeof p.toStatus === 'string') {
    out.push({ label: 'Step', value: `${typeof p.fromStatus === 'string' ? p.fromStatus : '?'} → ${p.toStatus}` });
  } else if (typeof p.stayedOn === 'string') {
    out.push({ label: 'Stayed on', value: p.stayedOn });
  } else if (typeof p.fromStatus === 'string') {
    out.push({ label: 'At step', value: p.fromStatus });
  }
  if (Array.isArray(p.checks)) {
    const ids = (outcome: (o: unknown) => boolean) => (p.checks as unknown[])
      .filter((c): c is { id: unknown; outcome: unknown; blocking?: unknown } => !!c && typeof c === 'object')
      // Only blocking checks: a soft one did not cause the refusal.
      .filter(c => c.blocking !== false && outcome(c.outcome) && typeof c.id === 'string')
      .map(c => c.id as string);
    const failed = ids(o => o === 'fail');
    const notRun = ids(o => o === 'unavailable');
    if (failed.length) out.push({ label: 'Failed checks', value: failed.join(', ') });
    if (notRun.length) out.push({ label: 'Not run', value: notRun.join(', ') });
  }
  if (Array.isArray(p.changedFields) && p.changedFields.length) {
    out.push({ label: 'Changed', value: p.changedFields.map(String).join(', ') });
  }
  if (Array.isArray(p.argv) && p.argv.length) {
    out.push({ label: 'Command', value: cap(p.argv.map(String).join(' ')) });
  }
  const flow = p.flow as { name?: unknown } | undefined;
  if (flow && typeof flow.name === 'string' && flow.name) out.push({ label: 'Flow', value: flow.name });
  if (p.prNumber != null) {
    const value = `${typeof p.repo === 'string' ? `${p.repo} ` : ''}#${p.prNumber}`;
    const href = httpsUrl(e.pr_url);
    out.push(href ? { label: 'Pull request', value, href } : { label: 'Pull request', value });
  }
  if (typeof p.model === 'string' && p.model) out.push({ label: 'Model', value: p.model });
  if (typeof p.harness === 'string' && p.harness) out.push({ label: 'Harness', value: p.harness });
  const size = sizeText(p.sizing ?? p.sizingShadow);
  if (size) out.push({ label: 'Size', value: size });

  let extra = 0;
  for (const [k, v] of Object.entries(p)) {
    if (HANDLED.has(k) || extra >= MAX_EXTRA) continue;
    if (typeof v === 'string' ? v === '' : typeof v !== 'number' && typeof v !== 'boolean') continue;
    out.push({ label: humanise(k), value: cap(String(v)) });
    extra++;
  }
  return out;
}
