import { airlockPolicyErrors, normalizeAirlockPolicy, type AirlockPolicy } from '@agenfk/core';
import type { DB } from '../db.js';

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
