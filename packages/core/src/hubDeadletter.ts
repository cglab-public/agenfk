/**
 * The spoke's hub deadletter file (~/.agenfk/hub-deadletter.jsonl), as data.
 *
 * The server flusher appends one line per event the hub refused, and deletes
 * the event's outbox row right after, so a line is the LAST copy of that event.
 * Everything here is pure: the CLI (list, discard, status) and the server
 * (requeue, status, the board's /hub/refusals) share these rules, and the I/O
 * stays with each caller. (#223)
 */

/** One line of the deadletter file, as the flusher writes it. */
export interface DeadletterEntry {
  eventId?: string | null;
  occurredAt?: string;
  deadletteredAt?: string;
  reason?: string;
  payload?: { orgId?: unknown; [k: string]: unknown } | string | null;
}

/**
 * One physical line of the file. `entry` is null for a line that does not
 * parse to an object: it may still be the last copy of something, so every
 * rewrite keeps it verbatim (only a CRLF file's trailing CR is dropped).
 */
export interface DeadletterLine {
  raw: string;
  entry: DeadletterEntry | null;
}

export function parseDeadletterLines(raw: string): DeadletterLine[] {
  const out: DeadletterLine[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    let entry: DeadletterEntry | null = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entry = parsed;
    } catch { /* kept as unparseable */ }
    out.push({ raw: line, entry });
  }
  return out;
}

/** The file content for these lines; '' for none. */
export function serializeDeadletterLines(lines: DeadletterLine[]): string {
  return lines.length === 0 ? '' : lines.map(l => l.raw).join('\n') + '\n';
}

/** The hub's refusal reason for a line; a line without one counts as 'unknown'. */
export function deadletterReasonOf(e: DeadletterEntry): string {
  return typeof e.reason === 'string' && e.reason ? e.reason : 'unknown';
}

/**
 * Left out of a requeue unless asked for by name:
 * - hidden_user: an admin hid this person; the hub drops them by design.
 * - org_mismatch: stamped with another org; only `hub carry-over` may rewrite
 *   that stamp, so these need --org and a carry-over afterwards.
 * - invalid: the hub could not read them; a resend is refused identically.
 */
export const REQUEUE_DEFAULT_EXCLUDED_REASONS: readonly string[] = ['hidden_user', 'org_mismatch', 'invalid'];

export interface RequeueFilters {
  reasons?: string[];
  org?: string;
  types?: string[];
  since?: string;
}

const FILTER_KEYS = new Set(['reasons', 'org', 'types', 'since']);
const REASON_SHAPE = /^[a-z][a-z_]{0,63}$/;

const nonEmptyStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.length > 0);

export function validateRequeueFilters(input: unknown):
  { ok: true; filters: RequeueFilters } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, filters: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'filters must be an object.' };
  const raw = input as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter(k => !FILTER_KEYS.has(k));
  if (unknownKeys.length > 0) return { ok: false, error: `Unknown filter(s): ${unknownKeys.join(', ')}.` };

  const filters: RequeueFilters = {};
  if (raw.reasons !== undefined) {
    if (!nonEmptyStrings(raw.reasons) || !raw.reasons.every(r => REASON_SHAPE.test(r))) {
      return { ok: false, error: 'reasons must be a non-empty list of reason codes (e.g. foreign_installation).' };
    }
    filters.reasons = [...raw.reasons];
  }
  if (raw.org !== undefined) {
    if (typeof raw.org !== 'string' || !raw.org) return { ok: false, error: 'org must be a non-empty string.' };
    filters.org = raw.org;
  }
  if (raw.types !== undefined) {
    if (!nonEmptyStrings(raw.types)) return { ok: false, error: 'types must be a non-empty list of event types.' };
    filters.types = [...raw.types];
  }
  if (raw.since !== undefined) {
    if (typeof raw.since !== 'string' || Number.isNaN(Date.parse(raw.since))) {
      return { ok: false, error: 'since must be an ISO date or timestamp.' };
    }
    filters.since = raw.since;
  }
  if (filters.reasons?.includes('org_mismatch') && !filters.org) {
    return {
      ok: false,
      error: 'org_mismatch events carry a stale org stamp: name it with --org <oldOrg>, then move them with '
        + '`agenfk hub carry-over --from <oldOrg> --to <org>` (the only command that may rewrite an org stamp).',
    };
  }
  return { ok: true, filters };
}

/** A line that can go back into the outbox, with what the outbox needs. */
export interface RequeueCandidate {
  /** Position in the parsed line list: the rewrite drops exactly these. */
  index: number;
  eventId: string;
  occurredAt: string;
  payloadJson: string;
  reason: string;
  type: string | null;
  orgId: string | null;
  installationId: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Which lines may go back to the outbox. `excluded` counts the rest, each under
 * the first rule it failed: 'unparseable', 'unreplayable', 'reason:<reason>',
 * 'org', 'type', 'since'.
 *
 * Unreplayable: no object payload, no string payload.eventId, or a line eventId
 * that differs from the payload's. The outbox key must equal payload.eventId —
 * the flusher matches the hub's rejections by the payload's id and deletes by
 * the key, so a mismatch would turn the next refusal into a silent delete.
 */
export function selectForRequeue(lines: DeadletterLine[], filters: RequeueFilters):
  { selected: RequeueCandidate[]; excluded: Record<string, number> } {
  const selected: RequeueCandidate[] = [];
  const excluded: Record<string, number> = {};
  const exclude = (cause: string) => { excluded[cause] = (excluded[cause] ?? 0) + 1; };
  const since = filters.since !== undefined ? Date.parse(filters.since) : null;

  lines.forEach((line, index) => {
    const e = line.entry;
    if (!e) return exclude('unparseable');
    const payload = e.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return exclude('unreplayable');
    const eventId = str(payload.eventId);
    if (!eventId || e.eventId !== eventId) return exclude('unreplayable');
    const occurredAt = str(e.occurredAt) ?? str(payload.occurredAt);
    if (!occurredAt) return exclude('unreplayable');

    const reason = deadletterReasonOf(e);
    const reasonSelected = filters.reasons
      ? filters.reasons.includes(reason)
      : !REQUEUE_DEFAULT_EXCLUDED_REASONS.includes(reason);
    if (!reasonSelected) return exclude(`reason:${reason}`);

    const orgId = str(payload.orgId);
    if (filters.org !== undefined && orgId !== filters.org) return exclude('org');
    const type = str(payload.type);
    if (filters.types && !(type && filters.types.includes(type))) return exclude('type');
    if (since !== null) {
      const at = Date.parse(occurredAt);
      if (Number.isNaN(at) || at < since) return exclude('since');
    }
    selected.push({
      index, eventId, occurredAt, payloadJson: JSON.stringify(payload), reason, type, orgId,
      installationId: str(payload.installationId),
    });
  });
  return { selected, excluded };
}

export interface RequeueSummary {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  byReason: Record<string, number>;
  byType: Record<string, number>;
  byOrg: Record<string, number>;
  byInstallation: Record<string, number>;
}

const NONE = '(none)';

export function summarizeRequeue(selected: RequeueCandidate[]): RequeueSummary {
  const s: RequeueSummary = { count: 0, firstAt: null, lastAt: null, byReason: {}, byType: {}, byOrg: {}, byInstallation: {} };
  const tally = (m: Record<string, number>, k: string | null) => { const key = k ?? NONE; m[key] = (m[key] ?? 0) + 1; };
  for (const c of selected) {
    s.count++;
    if (!s.firstAt || c.occurredAt < s.firstAt) s.firstAt = c.occurredAt;
    if (!s.lastAt || c.occurredAt > s.lastAt) s.lastAt = c.occurredAt;
    tally(s.byReason, c.reason);
    tally(s.byType, c.type);
    tally(s.byOrg, c.orgId);
    tally(s.byInstallation, c.installationId);
  }
  return s;
}

/**
 * The sticky refusal indicator. It is derived from the file, not from the
 * flusher's memory, so it survives flushes, restarts and re-joins, and clears
 * only when the file is emptied (requeued or discarded). hidden_user lines are
 * not actionable: they are an admin's decision, not a fault.
 */
export interface DeadletterIndicator {
  count: number;
  actionable: number;
  /** The oldest deadletteredAt in the file. */
  since: string | null;
  reasons: Record<string, number>;
  unparseable: number;
}

export function deadletterIndicator(lines: DeadletterLine[]): DeadletterIndicator {
  const ind: DeadletterIndicator = { count: lines.length, actionable: 0, since: null, reasons: {}, unparseable: 0 };
  for (const l of lines) {
    if (!l.entry) { ind.unparseable++; ind.actionable++; continue; }
    const reason = deadletterReasonOf(l.entry);
    ind.reasons[reason] = (ind.reasons[reason] ?? 0) + 1;
    if (reason !== 'hidden_user') ind.actionable++;
    const at = str(l.entry.deadletteredAt);
    if (at && (!ind.since || at < ind.since)) ind.since = at;
  }
  return ind;
}

/** What to do about refusals with this reason. */
export function refusalHint(reason: string): string {
  switch (reason) {
    case 'foreign_installation':
      return "This machine's hub key is bound to another installation, or this installation belongs to another org. "
        + 'Ask a hub admin for a new invite, run `agenfk hub join`, then `agenfk hub deadletter requeue`.';
    case 'org_mismatch':
      return 'These events are stamped with another org. Requeue them with `agenfk hub deadletter requeue --reason org_mismatch --org <oldOrg>`, '
        + 'then `agenfk hub carry-over --from <oldOrg> --to <org>`.';
    case 'hidden_user':
      return 'A hub admin hid this person, so the hub drops their events by design. Remove them with `agenfk hub deadletter discard --reason hidden_user`.';
    case 'invalid':
      return 'The hub could not read these events, and a resend would be refused the same way. Remove them with `agenfk hub deadletter discard --reason invalid`.';
    case 'unparseable':
      return 'Some deadletter lines cannot be read, so they cannot be sent again. Remove them with `agenfk hub deadletter discard --unparseable`.';
    default:
      return 'Inspect them with `agenfk hub deadletter`, fix the cause, then `agenfk hub deadletter requeue`.';
  }
}

/** The hint for the most frequent actionable reason; null when nothing is actionable. */
export function indicatorHint(ind: DeadletterIndicator): string | null {
  if (ind.actionable === 0) return null;
  const top = Object.entries(ind.reasons)
    .filter(([reason]) => reason !== 'hidden_user')
    .sort((a, b) => b[1] - a[1])[0];
  // Only unreadable lines are actionable: requeue cannot move those.
  return refusalHint(top ? top[0] : 'unparseable');
}
