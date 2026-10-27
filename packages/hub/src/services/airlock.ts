import { airlockPolicyErrors, normalizeAirlockPolicy, type AirlockPolicy } from '@agenfk/core';
import type { DB } from '../db.js';
import { listAudit } from './configAudit.js';

/**
 * The org's Airlock policy (GH-294, T3): one row per org, kept by its admins
 * and adopted by every joined installation, which cannot overrule it.
 *
 * Two revisions, because two things change at different speeds: `revision`
 * moves when an admin saves the policy, `iocRevision` when only the IOC host
 * list moves. The installation's ETag carries both, so either busts its cache.
 * They live in separate columns (policy_json / ioc_hosts_json) and each write
 * touches only its own, so a policy save and an IOC save can never overwrite
 * each other's lists.
 *
 * Every write is a single conditional statement - UPDATE ... WHERE revision = ?
 * or INSERT ... ON CONFLICT DO NOTHING - checked by its affected-row count, so
 * the compare-and-swap holds across hub processes, not only within this one.
 *
 * Validation is the shared `airlockPolicyErrors`, the same one the server
 * applies to a local write and to what it adopts from here, preceded by size
 * caps so an oversized list is refused before any per-entry work.
 */

export const MAX_HOSTS_PER_LIST = 1000;
export const MAX_IOC_HOSTS = 10_000;
export const MAX_MODELS = 100;
/** The longest a DNS name can be; a CIDR or wildcard pattern is shorter still. */
export const MAX_HOST_CHARS = 253;
export const MAX_SELECTOR_CHARS = 256;

export interface AirlockPolicyView {
  policy: AirlockPolicy | null;
  revision: number;
  iocRevision: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export class AirlockPolicyError extends Error {
  constructor(public code: 'invalid_policy' | 'revision_conflict' | 'no_policy', message: string, public errors: string[] = []) {
    super(message);
  }
}

interface Row {
  org_id: string;
  revision: number | string;
  policy_json: string;
  ioc_revision: number | string;
  ioc_hosts_json: string;
  ioc_updated_at: string | Date | null;
  updated_at: string | Date;
  updated_by_email: string | null;
}

const iso = (v: string | Date | null): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/** Postgres hands numerics back as strings and may hand timestamps back as Dates: read both as SQLite does. */
function viewOf(row: Row | undefined): AirlockPolicyView {
  if (!row) return { policy: null, revision: 0, iocRevision: 0, updatedAt: null, updatedByEmail: null };
  const iocRevision = Number(row.ioc_revision);
  const raw = parse(row.policy_json);
  const policy = normalizeAirlockPolicy({
    ...(raw && typeof raw === 'object' ? raw : {}),
    iocHosts: { revision: String(iocRevision), hosts: parse(row.ioc_hosts_json), updatedAt: iso(row.ioc_updated_at) },
  });
  return {
    policy,
    revision: Number(row.revision),
    iocRevision,
    updatedAt: iso(row.updated_at),
    updatedByEmail: row.updated_by_email ?? null,
  };
}

async function readRow(db: DB, orgId: string): Promise<Row | undefined> {
  return db.get<Row>(
    `SELECT org_id, revision, policy_json, ioc_revision, ioc_hosts_json, ioc_updated_at, updated_at, updated_by_email
     FROM airlock_policies WHERE org_id = ?`,
    [orgId],
  );
}

export async function getAirlockPolicy(db: DB, orgId: string): Promise<AirlockPolicyView> {
  return viewOf(await readRow(db, orgId));
}

/** The installation's cache key: both revisions, so an IOC-only change busts it too. */
export const airlockEtagOf = (v: AirlockPolicyView): string => `W/"${v.revision}:${v.iocRevision}"`;

function hostListCapErrors(field: string, raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const errors: string[] = [];
  if (raw.length > max) errors.push(`${field}: at most ${max} entries (got ${raw.length})`);
  if (raw.some(h => typeof h === 'string' && h.length > MAX_HOST_CHARS)) {
    errors.push(`${field}: a host pattern is at most ${MAX_HOST_CHARS} characters`);
  }
  return errors;
}

/** Size caps, checked before validation so an oversized list costs nothing per entry. */
function policyCapErrors(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, any>;
  const errors: string[] = [];
  if (Array.isArray(b.models)) {
    if (b.models.length > MAX_MODELS) errors.push(`models: at most ${MAX_MODELS} entries (got ${b.models.length})`);
    else if (b.models.some((m: any) => m && typeof m === 'object'
      && ['client', 'provider', 'model'].some(k => typeof m[k] === 'string' && m[k].length > MAX_SELECTOR_CHARS))) {
      errors.push(`models: each field is at most ${MAX_SELECTOR_CHARS} characters`);
    }
  }
  if (b.hosts && typeof b.hosts === 'object') {
    errors.push(...hostListCapErrors('hosts.allow', b.hosts.allow, MAX_HOSTS_PER_LIST));
    errors.push(...hostListCapErrors('hosts.deny', b.hosts.deny, MAX_HOSTS_PER_LIST));
  }
  return errors;
}

const conflict = (what: string) => new AirlockPolicyError(
  'revision_conflict', `The ${what} changed since it was read. Reload and apply the change again.`,
);

/**
 * Save the policy as the next revision. The IOC list is not the policy's to
 * change: whatever `iocHosts` the body carries is ignored. `expectedRevision`,
 * when given, must match what is stored; either way the write itself only
 * lands on the revision that was read.
 */
export async function putAirlockPolicy(
  db: DB, orgId: string, body: unknown, expectedRevision: unknown, email: string | null,
): Promise<AirlockPolicyView> {
  const errors = [...policyCapErrors(body)];
  if (!errors.length) errors.push(...airlockPolicyErrors(body));
  if (errors.length) throw new AirlockPolicyError('invalid_policy', 'Invalid Airlock policy', errors);
  if (expectedRevision !== undefined && expectedRevision !== null
    && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new AirlockPolicyError('invalid_policy', 'expectedRevision must be a whole number (0 before the first save)');
  }
  const current = await readRow(db, orgId);
  const readRevision = current ? Number(current.revision) : 0;
  if (typeof expectedRevision === 'number' && expectedRevision !== readRevision) {
    throw new AirlockPolicyError(
      'revision_conflict',
      `The policy changed since it was read: it is at revision ${readRevision}, not ${expectedRevision}. Reload and apply the change again.`,
    );
  }
  const { iocHosts: _ioc, ...policy } = normalizeAirlockPolicy(body);
  const json = JSON.stringify(policy);
  const now = new Date().toISOString();
  const result = current
    ? await db.run(
      'UPDATE airlock_policies SET revision = ?, policy_json = ?, updated_at = ?, updated_by_email = ? WHERE org_id = ? AND revision = ?',
      [readRevision + 1, json, now, email, orgId, readRevision],
    )
    // The NOT EXISTS is for pg-mem, which counts an ON CONFLICT DO NOTHING
    // skip as a changed row; ON CONFLICT is what settles a real race.
    : await db.run(
      `INSERT INTO airlock_policies (org_id, revision, policy_json, ioc_revision, ioc_hosts_json, updated_at, updated_by_email)
       SELECT ?, 1, ?, 0, '[]', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM airlock_policies WHERE org_id = ?)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, json, now, email, orgId],
    );
  if (result.changes !== 1) throw conflict('policy');
  return viewOf(await readRow(db, orgId));
}

/** Replace the IOC host list; refused until the org has a policy to carry it. */
export async function putAirlockIocHosts(db: DB, orgId: string, hosts: unknown, email: string | null): Promise<AirlockPolicyView> {
  if (!Array.isArray(hosts)) throw new AirlockPolicyError('invalid_policy', 'hosts must be an array of host patterns');
  const errors = hostListCapErrors('iocHosts.hosts', hosts, MAX_IOC_HOSTS);
  if (!errors.length) errors.push(...airlockPolicyErrors({ iocHosts: { hosts } }));
  if (errors.length) throw new AirlockPolicyError('invalid_policy', 'Invalid IOC host list', errors);
  const current = await readRow(db, orgId);
  if (!current) throw new AirlockPolicyError('no_policy', 'Save an Airlock policy before setting its IOC host list.');
  const readIoc = Number(current.ioc_revision);
  const normalized = normalizeAirlockPolicy({ iocHosts: { hosts } }).iocHosts.hosts;
  const now = new Date().toISOString();
  const result = await db.run(
    `UPDATE airlock_policies SET ioc_revision = ?, ioc_hosts_json = ?, ioc_updated_at = ?, updated_at = ?, updated_by_email = ?
     WHERE org_id = ? AND ioc_revision = ?`,
    [readIoc + 1, JSON.stringify(normalized), now, now, email, orgId, readIoc],
  );
  if (result.changes !== 1) throw conflict('IOC host list');
  return viewOf(await readRow(db, orgId));
}

/**
 * The row as an audit snapshot, or null before the first save. Rules are
 * listed as {rule, action} pairs: a rule NAMED like a secret
 * (credentialReadWithNetwork) would otherwise have its action - a validated
 * enum, never a secret - redacted by the audit's key-name rule.
 */
export async function airlockAuditSnapshot(db: DB, orgId: string): Promise<unknown> {
  const view = await getAirlockPolicy(db, orgId);
  if (!view.policy) return null;
  const { rules, ...policy } = view.policy;
  return { ...view, policy: { ...policy, rules: Object.entries(rules).map(([rule, action]) => ({ rule, action })) } };
}

// ── Which policy each installation applies (HUB-2) ─────────────────────────

/** The longest refusal reason kept; the installation already cuts it, this is the hub's own bound. */
export const MAX_REFUSAL_CHARS = 500;

const wholeAtLeast = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

/** How far past the hub's clock a report may be dated: an installation's clock may run a little ahead. */
export const MAX_REPORT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A report's time as the hub orders reports by it: the installation's
 * occurredAt in one format (ISO UTC, so text order is time order). Null - the
 * report is refused - when it cannot be read or is dated more than the skew
 * past the hub's clock: a report from the future would freeze every later one
 * out, and moving it to the time it arrived would reorder it among others.
 */
export function reportTimeOf(occurredAt: unknown, now: Date = new Date()): string | null {
  const t = typeof occurredAt === 'string' ? Date.parse(occurredAt) : NaN;
  if (!Number.isFinite(t) || t > now.getTime() + MAX_REPORT_CLOCK_SKEW_MS) return null;
  return new Date(t).toISOString();
}

/**
 * Whether an applied state covers a refused one: it holds that policy revision
 * or a later one AND that IOC revision or a later one. Applying 5/ioc1 does
 * not answer a refusal of 5/ioc2, however often it is reported. A refusal
 * with no revision (a malformed answer) is covered by any apply; one with no
 * IOC revision is judged on the policy revision alone.
 */
const covers = (appliedRev: string, appliedIoc: string, refusedRev: string, refusedIoc: string) =>
  `((${refusedRev} IS NULL OR ${refusedRev} <= ${appliedRev}) AND (${refusedIoc} IS NULL OR ${refusedIoc} <= ${appliedIoc}))`;

/** An applied report clears a refusal it covers and does not predate. */
const CLEARS_REFUSAL = `(airlock_installations.refused_at IS NOT NULL
  AND airlock_installations.refused_at <= excluded.reported_at
  AND ${covers('excluded.applied_revision', 'excluded.applied_ioc_revision', 'airlock_installations.refused_revision', 'airlock_installations.refused_ioc_revision')})`;

/**
 * The same rule from the other side, stricter: a refusal landing after an
 * applied report that covers it and is STRICTLY later is already answered - a
 * late delivery must not bring it back. One the apply does not cover is kept,
 * whatever its time; so is one at the same instant (the installation sends
 * the state it keeps and its refusal together) and one with no revision,
 * which no apply can be shown to answer. Either is still cleared by a later apply.
 */
const ANSWERED_REFUSAL = `(airlock_installations.reported_at IS NOT NULL
  AND airlock_installations.reported_at > excluded.refused_at
  AND excluded.refused_revision IS NOT NULL
  AND ${covers('airlock_installations.applied_revision', 'airlock_installations.applied_ioc_revision', 'excluded.refused_revision', 'excluded.refused_ioc_revision')})`;

/**
 * An installation's `airlock.policy-applied` report. A report older than the
 * stored one (by reportTimeOf) changes nothing, so reports landing out of
 * order cannot roll the revision back. applied_at stays when the same
 * revisions are reported again; a refusal of this revision or an earlier one,
 * reported before this, is cleared.
 */
export async function recordAirlockApplied(
  db: DB, orgId: string, installationId: string, payload: unknown, occurredAt: string,
): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (!wholeAtLeast(p.revision, 0) || !wholeAtLeast(p.iocRevision, 0)) return false;
  const at = reportTimeOf(occurredAt);
  if (!at) return false;
  const result = await db.run(
    `INSERT INTO airlock_installations (org_id, installation_id, applied_revision, applied_ioc_revision, applied_at, reported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, installation_id) DO UPDATE SET
       applied_at = CASE
         WHEN airlock_installations.applied_revision = excluded.applied_revision
          AND airlock_installations.applied_ioc_revision = excluded.applied_ioc_revision
          AND airlock_installations.applied_at IS NOT NULL
         THEN airlock_installations.applied_at ELSE excluded.applied_at END,
       applied_revision = excluded.applied_revision,
       applied_ioc_revision = excluded.applied_ioc_revision,
       reported_at = excluded.reported_at,
       refused_revision = CASE WHEN ${CLEARS_REFUSAL} THEN NULL ELSE airlock_installations.refused_revision END,
       refused_ioc_revision = CASE WHEN ${CLEARS_REFUSAL} THEN NULL ELSE airlock_installations.refused_ioc_revision END,
       refused_error = CASE WHEN ${CLEARS_REFUSAL} THEN NULL ELSE airlock_installations.refused_error END,
       refused_at = CASE WHEN ${CLEARS_REFUSAL} THEN NULL ELSE airlock_installations.refused_at END
     WHERE airlock_installations.reported_at IS NULL OR airlock_installations.reported_at <= excluded.reported_at`,
    [orgId, installationId, p.revision, p.iocRevision, at, at],
  );
  return result.changes > 0;
}

/**
 * An installation's `airlock.policy-refused` report: what it applies is left
 * as it was, and a refusal an applied report has already answered is ignored.
 */
export async function recordAirlockRefused(
  db: DB, orgId: string, installationId: string, payload: unknown, occurredAt: string,
): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const revision = p.revision === null || p.revision === undefined ? null : p.revision;
  if (revision !== null && !wholeAtLeast(revision, 0)) return false;
  if (typeof p.error !== 'string') return false;
  const iocRevision = p.iocRevision === null || p.iocRevision === undefined ? null : p.iocRevision;
  if (iocRevision !== null && !wholeAtLeast(iocRevision, 0)) return false;
  const at = reportTimeOf(occurredAt);
  if (!at) return false;
  const result = await db.run(
    `INSERT INTO airlock_installations (org_id, installation_id, refused_revision, refused_ioc_revision, refused_error, refused_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, installation_id) DO UPDATE SET
       refused_revision = excluded.refused_revision,
       refused_ioc_revision = excluded.refused_ioc_revision,
       refused_error = excluded.refused_error,
       refused_at = excluded.refused_at
     WHERE (airlock_installations.refused_at IS NULL OR airlock_installations.refused_at <= excluded.refused_at)
       AND NOT ${ANSWERED_REFUSAL}`,
    [orgId, installationId, revision, iocRevision, p.error.slice(0, MAX_REFUSAL_CHARS), at],
  );
  return result.changes > 0;
}

export interface AirlockInstallationView {
  installationId: string;
  osUser: string | null;
  gitName: string | null;
  gitEmail: string | null;
  lastSeen: string | null;
  appliedRevision: number | null;
  appliedIocRevision: number | null;
  appliedAt: string | null;
  reportedAt: string | null;
  refusedRevision: number | null;
  refusedIocRevision: number | null;
  refusedError: string | null;
  refusedAt: string | null;
  /** The org has a policy and this installation has not reported applying all of it. */
  behind: boolean;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The org's installations - not retired, not a hidden person's (whose reports
 * are dropped at ingest, so they would read as behind forever) - each with the
 * revision it last reported applying, against the org's current one.
 */
export async function listAirlockInstallations(db: DB, orgId: string): Promise<{
  currentRevision: number; currentIocRevision: number; installations: AirlockInstallationView[];
}> {
  const current = await getAirlockPolicy(db, orgId);
  // LEFT JOIN + IS NULL for the hidden exclusion: a correlated NOT EXISTS on the
  // outer alias does not run on pg-mem.
  const rows = await db.all<any>(
    `SELECT i.id, i.os_user, i.git_name, i.git_email, i.last_seen,
            a.applied_revision, a.applied_ioc_revision, a.applied_at, a.reported_at,
            a.refused_revision, a.refused_ioc_revision, a.refused_error, a.refused_at
       FROM installations i
       LEFT JOIN airlock_installations a ON a.org_id = i.org_id AND a.installation_id = i.id
       LEFT JOIN hidden_users h ON h.org_id = i.org_id AND h.user_key = lower(i.git_email)
      WHERE i.org_id = ? AND i.retired_at IS NULL AND h.user_key IS NULL
      ORDER BY i.last_seen DESC, i.id`,
    [orgId],
  );
  const installations = rows.map((r): AirlockInstallationView => {
    const appliedRevision = numOrNull(r.applied_revision);
    const appliedIocRevision = numOrNull(r.applied_ioc_revision);
    const behind = current.revision > 0 && (
      appliedRevision === null
      || appliedRevision < current.revision
      || (appliedRevision === current.revision && (appliedIocRevision ?? 0) < current.iocRevision));
    return {
      installationId: String(r.id),
      osUser: r.os_user ?? null,
      gitName: r.git_name ?? null,
      gitEmail: r.git_email ?? null,
      lastSeen: iso(r.last_seen ?? null),
      appliedRevision,
      appliedIocRevision,
      appliedAt: iso(r.applied_at ?? null),
      reportedAt: iso(r.reported_at ?? null),
      refusedRevision: numOrNull(r.refused_revision),
      refusedIocRevision: numOrNull(r.refused_ioc_revision),
      refusedError: r.refused_error ?? null,
      refusedAt: iso(r.refused_at ?? null),
      behind,
    };
  });
  return { currentRevision: current.revision, currentIocRevision: current.iocRevision, installations };
}

export interface AirlockHistoryEntry {
  id: string;
  at: string;
  actorEmail: string | null;
  source: string;
  action: string;
  before: { revision: number; iocRevision: number } | null;
  after: { revision: number; iocRevision: number } | null;
}

/** The revisions of an audit snapshot (airlockAuditSnapshot), or null for "no policy". */
function revisionsOf(snapshot: unknown): { revision: number; iocRevision: number } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.revision !== 'number') return null;
  return { revision: s.revision, iocRevision: typeof s.iocRevision === 'number' ? s.iocRevision : 0 };
}

/**
 * The policy's revision history, from the config audit (area 'airlock'):
 * who changed it, when, and from which revision to which. The policies
 * themselves stay in the Audit tab; this is the list of revisions.
 */
export async function listAirlockHistory(
  db: DB, orgId: string, opts: { limit?: number; cursor?: string } = {},
): Promise<{ entries: AirlockHistoryEntry[]; next: string | null }> {
  const page = await listAudit(db, orgId, { area: 'airlock', limit: opts.limit, cursor: opts.cursor });
  return {
    entries: page.rows.map(r => ({
      id: r.id, at: r.at, actorEmail: r.actorEmail, source: r.source, action: r.action,
      before: revisionsOf(r.before), after: revisionsOf(r.after),
    })),
    next: page.next,
  };
}
