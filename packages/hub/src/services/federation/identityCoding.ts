import type { DB } from '../../db.js';

/**
 * What a child hub codes before it forwards an event to its parent (GH-395).
 *
 * Two fields, each sent as written or coded:
 *  - `person`: the user key becomes a per-hub code, and everything that can
 *    carry the person goes with it — the actor (OS user, git name, git email),
 *    the item title and the free-form payload, which is reduced to the keys
 *    the parent aggregates plus the usage numbers;
 *  - `installation`: the installation id becomes a per-hub code.
 *
 * Everything else (model, harness, step names, repository, ticket) is always
 * sent as written. Each field has a group default on the parent and an
 * optional per-child override; nothing set means as written.
 *
 * This replaced a binary `keep` | `pseudonymize` policy. Parents and children
 * upgrade separately, so the wire carries both: the per-field `identity`, and
 * the binary `identityPolicy` an older hub reads (`pseudonymize` whenever
 * anything is coded, so an older peer never sends or names more than asked).
 */
export type FieldCoding = 'as-written' | 'coded';
export type IdentityField = 'person' | 'installation';
export type IdentityCoding = Record<IdentityField, FieldCoding>;
/** A setting as stored: a field left null follows the next level down. */
export type IdentitySetting = Record<IdentityField, FieldCoding | null>;
export type LegacyIdentityPolicy = 'keep' | 'pseudonymize';

export const IDENTITY_FIELDS: readonly IdentityField[] = ['person', 'installation'];
export const AS_WRITTEN: IdentityCoding = Object.freeze({ person: 'as-written', installation: 'as-written' }) as IdentityCoding;
const BOTH_CODED: IdentityCoding = { person: 'coded', installation: 'coded' };

/** The column each field is stored in, on org_settings and child_hubs alike. */
export const IDENTITY_COLUMNS: Record<IdentityField, string> = {
  person: 'identity_person',
  installation: 'identity_installation',
};

/** Both columns, for a SELECT list. */
export const IDENTITY_SELECT = IDENTITY_FIELDS.map(f => IDENTITY_COLUMNS[f]).join(', ');

export function asFieldCoding(v: unknown): FieldCoding | null {
  return v === 'as-written' || v === 'coded' ? v : null;
}

/**
 * The coding in force for one child: its own value per field, else the
 * group's, else as written. An unrecognised value counts as unset rather
 * than being guessed at.
 */
export function effectiveIdentityCoding(
  group: Partial<Record<IdentityField, unknown>> | null | undefined,
  child: Partial<Record<IdentityField, unknown>> | null | undefined,
): IdentityCoding {
  const pick = (f: IdentityField): FieldCoding => asFieldCoding(child?.[f]) ?? asFieldCoding(group?.[f]) ?? 'as-written';
  return { person: pick('person'), installation: pick('installation') };
}

/** A stored row's setting: the two columns, each kept only when recognised. */
export function settingFromRow(row: Record<string, unknown> | null | undefined): IdentitySetting {
  return {
    person: asFieldCoding(row?.[IDENTITY_COLUMNS.person]),
    installation: asFieldCoding(row?.[IDENTITY_COLUMNS.installation]),
  };
}

export const anyCoded = (c: IdentityCoding): boolean => c.person === 'coded' || c.installation === 'coded';

/** What a hub from before per-field coding reads: anything coded is its `pseudonymize`. */
export function legacyPolicyFor(c: IdentityCoding): LegacyIdentityPolicy {
  return anyCoded(c) ? 'pseudonymize' : 'keep';
}

function fromLegacy(v: unknown): IdentityCoding | null {
  if (v === 'pseudonymize') return { ...BOTH_CODED };
  if (v === 'keep') return { ...AS_WRITTEN };
  return null;
}

function completeCoding(v: unknown): IdentityCoding | null {
  if (!v || typeof v !== 'object') return null;
  const person = asFieldCoding((v as any).person);
  const installation = asFieldCoding((v as any).installation);
  return person && installation ? { person, installation } : null;
}

/**
 * The coding a parent told this child, on enrolment or a heartbeat: the
 * per-field shape when it is complete; when there is none, an older parent's
 * binary policy (`pseudonymize` codes both fields: that parent's admin asked
 * to hide people, and reading it as nothing coded would send what they hid).
 * A per-field shape that is present but incomplete or unrecognised codes both
 * fields, whatever the binary label beside it says: a malformed answer must
 * never send more. Null when the parent said nothing recognisable, so the
 * cached value stands.
 */
export function codingFromWire(body: unknown): IdentityCoding | null {
  if (!body || typeof body !== 'object') return null;
  const identity = (body as any).identity;
  if (identity !== undefined && identity !== null) return completeCoding(identity) ?? { ...BOTH_CODED };
  return fromLegacy((body as any).identityPolicy);
}

/**
 * The coding a forwarded row was queued under: the per-field shape, else (with
 * none) an older child's binary label. Null for a row that names neither, or
 * whose per-field shape is malformed, which the parent then trusts with nothing.
 */
export function codingOfRow(payload: unknown): IdentityCoding | null {
  if (!payload || typeof payload !== 'object') return null;
  const identity = (payload as any).identity;
  if (identity !== undefined && identity !== null) return completeCoding(identity);
  return fromLegacy((payload as any).identityPolicy);
}

export const sameCoding = (a: IdentityCoding, b: IdentityCoding): boolean =>
  a.person === b.person && a.installation === b.installation;

/** The coding in force for a child hub (or, with no child, the group's), read from the parent's own settings. */
export async function effectiveCodingFor(
  db: Pick<DB, 'get'>, orgId: string, childHubId: string | null,
): Promise<IdentityCoding> {
  const group = await db.get<Record<string, unknown>>(
    `SELECT ${IDENTITY_SELECT} FROM org_settings WHERE org_id = ?`, [orgId],
  );
  const child = childHubId
    ? await db.get<Record<string, unknown>>(
      `SELECT ${IDENTITY_SELECT} FROM child_hubs WHERE id = ? AND org_id = ?`, [childHubId, orgId],
    )
    : null;
  return effectiveIdentityCoding(settingFromRow(group), settingFromRow(child));
}
