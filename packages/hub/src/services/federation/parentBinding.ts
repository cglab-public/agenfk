import type { DB } from '../../db.js';
import { normalizeHttpUrl } from '../../util/httpUrl.js';
import { encryptSecret, decryptSecret } from '../../crypto.js';

/**
 * The child hub's record of its parent (CGLAB-181).
 *
 * Stored as a single `system_state` row rather than an env var so enrolment can
 * happen from the hub-ui at runtime, and so `agenfk hub` operators are not
 * asked to redeploy to join a group. The bearer token inside it is encrypted
 * with the hub's own AGENFK_HUB_SECRET_KEY; the parent URL deliberately is not,
 * because an operator reading the table should be able to see who this hub
 * reports to without being able to impersonate it.
 */
export const PARENT_BINDING_KEY = 'federation.parent';

export type BindingState = 'active' | 'revoked';

/**
 * How the parent wants this child's people identified upstream.
 *
 * The CHILD never chooses. The value is set at the parent — group-wide or per
 * child hub — and rides back on the heartbeat, so there is no new endpoint and
 * no directive kind. 'keep' is the default because a group is usually one
 * organisation with several teams, and a group view that cannot be reconciled
 * with the local ones is not much of a view.
 */
export type IdentityPolicy = 'keep' | 'pseudonymize';

/**
 * Coerce an untrusted value to a policy. Anything unrecognised — a corrupt
 * row, an older parent, a typo in a column — reads as 'keep'. Never guess
 * towards 'pseudonymize': silently anonymising a group's data because a value
 * did not parse is the worse failure of the two, and the harder to notice.
 */
export function asIdentityPolicy(v: unknown): IdentityPolicy {
  return v === 'pseudonymize' ? 'pseudonymize' : 'keep';
}

export interface ParentBinding {
  parentUrl: string;
  token: string;
  childHubId: string;
  enrolledAt: string;
  /**
   * 'revoked' means the parent answered 401 — detached at the other end. The
   * row is kept rather than deleted so the UI can say why sync stopped instead
   * of silently showing an unbound hub.
   */
  state: BindingState;
  /** Last policy the parent told us. Absent until the first heartbeat replies. */
  identityPolicy: IdentityPolicy;
}

interface StoredBinding {
  parentUrl: string;
  encToken: string;
  childHubId: string;
  enrolledAt: string;
  state: BindingState;
  identityPolicy: IdentityPolicy;
}

/**
 * Hosts a parent hub may not live on unless an operator says otherwise.
 *
 * The child fetches this URL with an admin-supplied value, so without a guard
 * the join form is a semi-blind SSRF probe: the route reflects the upstream
 * status and error body, which is enough to map internal ports. A LAN parent
 * is a legitimate deployment, so this is an opt-in rather than a hard no.
 */
const PRIVATE_HOST_RE = new RegExp([
  '^localhost$', '^127\\.', '^0\\.0\\.0\\.0$', '^\\[?::1\\]?$',
  '^10\\.', '^192\\.168\\.', '^169\\.254\\.',
  '^172\\.(1[6-9]|2[0-9]|3[01])\\.',
  '\\.local$', '\\.internal$',
  // IPv6: the unspecified address, unique-local (fc00::/7) and link-local
  // (fe80::/10). Not a blanket 'f' prefix — fe00:: is ordinary global space.
  '^::$', '^f[cd][0-9a-f]{2}:', '^fe[89ab][0-9a-f]:',
].join('|'), 'i');

/**
 * `::ffff:7f00:1` → `127.0.0.1`, so an IPv4-mapped address is judged by the
 * IPv4 rules rather than slipping through them.
 *
 * Mapping is not itself suspicious — `::ffff:8.8.8.8` is a public address — so
 * this translates rather than blocks. WHATWG URL re-spells the dotted form as
 * hex groups, which is exactly why the dotted block list missed these.
 */
function mappedIPv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

export function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  const mapped = mappedIPv4(bare);
  return PRIVATE_HOST_RE.test(bare) || (mapped !== null && PRIVATE_HOST_RE.test(mapped));
}

/** Only http(s): the URL is fetched by the worker, so file:// and javascript: are refused. */
export function assertHttpUrl(raw: string, opts: { allowPrivate?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('parentUrl must be a valid http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('parentUrl must be an http(s) URL');
  }
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) {
    throw new Error(
      'parentUrl points at a private or loopback address. Set AGENFK_HUB_ALLOW_PRIVATE_PARENT=1 if the parent hub really is on this network.',
    );
  }
  // One definition of the final form, shared with the invite-token decoder
  // so what an admin is shown is what gets dialled.
  return normalizeHttpUrl(raw)!;
}

export async function writeParentBinding(
  db: DB,
  secretKey: string,
  input: { parentUrl: string; token: string; childHubId: string; enrolledAt?: string; state?: BindingState; identityPolicy?: IdentityPolicy },
): Promise<void> {
  // The SAME allowance the join route applies, because this runs after the
  // parent has already accepted the enrolment. Re-validating more strictly here
  // made AGENFK_HUB_ALLOW_PRIVATE_PARENT useless and destructive: the join got
  // past the route's check, the invite was spent, the parent created a named
  // row — and then this threw, telling the operator to set the flag they had
  // already set. Every retry burnt another invite and stranded another row.
  const parentUrl = assertHttpUrl(input.parentUrl, {
    allowPrivate: process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT === '1',
  });
  const stored: StoredBinding = {
    parentUrl,
    encToken: encryptSecret(input.token, secretKey),
    childHubId: input.childHubId,
    enrolledAt: input.enrolledAt ?? new Date().toISOString(),
    state: input.state ?? 'active',
    identityPolicy: asIdentityPolicy(input.identityPolicy),
  };
  // One row, replaced, in one transaction. Delete-then-insert unguarded left a
  // window in which a concurrent reader saw NO binding — which would downgrade
  // a revoked hub to "never enrolled" and lose the explanation the revoked
  // state exists to carry.
  await db.transaction(async () => {
    await db.run('DELETE FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
    await db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [PARENT_BINDING_KEY, JSON.stringify(stored)]);
  });
}

export async function readParentBinding(db: DB, secretKey: string): Promise<ParentBinding | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
  if (!row?.value) return null;
  let stored: StoredBinding;
  try {
    stored = JSON.parse(row.value);
  } catch {
    // A row we cannot parse is not a binding. Throwing here would take the
    // worker — and every boot that starts it — down with it.
    return null;
  }
  if (!stored || typeof stored.encToken !== 'string' || typeof stored.parentUrl !== 'string') return null;
  // decryptSecret throws on a wrong key or a tampered blob, and that IS the
  // right outcome: silently treating it as "no parent" would have a hub whose
  // secret was rotated quietly stop reporting with nothing to explain it.
  const token = decryptSecret(stored.encToken, secretKey);
  return {
    parentUrl: stored.parentUrl,
    token,
    childHubId: stored.childHubId,
    enrolledAt: stored.enrolledAt,
    state: stored.state === 'revoked' ? 'revoked' : 'active',
    identityPolicy: asIdentityPolicy(stored.identityPolicy),
  };
}

/** Flip a binding to 'revoked' in place, keeping everything else. */
export async function markBindingRevoked(db: DB, secretKey: string): Promise<void> {
  const current = await readParentBinding(db, secretKey);
  if (!current || current.state === 'revoked') return;
  await writeParentBinding(db, secretKey, { ...current, state: 'revoked' });
}

export async function clearParentBinding(db: DB): Promise<void> {
  await db.run('DELETE FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
}

/**
 * Whether this hub has already asked its parent to release it. Kept beside the
 * binding rather than inside it so asking does not rewrite the encrypted blob,
 * and so it survives the binding flipping to 'revoked'.
 */
export const RELEASE_REQUESTED_KEY = 'federation.releaseRequested';

export async function releaseRequestedFlag(db: DB): Promise<boolean> {
  const row = await db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', [RELEASE_REQUESTED_KEY]);
  return row?.value === '1';
}

export async function setReleaseRequestedFlag(db: DB, on: boolean): Promise<void> {
  await db.run('DELETE FROM system_state WHERE key = ?', [RELEASE_REQUESTED_KEY]);
  if (on) await db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [RELEASE_REQUESTED_KEY, '1']);
}

/**
 * The binding's state WITHOUT decrypting it.
 *
 * `state` is stored in clear alongside the encrypted token precisely so this is
 * possible. The leave route needs it: it used to treat "cannot decrypt" as "no
 * parent" and clear the row, which turned rotating AGENFK_HUB_SECRET_KEY into a
 * way for a child to let itself out of a group through the product. Whether the
 * parent has released this hub is not a secret, and must not depend on holding
 * the key.
 */
export async function readBindingStateUnverified(
  db: DB,
): Promise<{ present: boolean; state: BindingState | null }> {
  const row = await db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
  if (!row?.value) return { present: false, state: null };
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed.encToken !== 'string') return { present: false, state: null };
    return { present: true, state: parsed.state === 'revoked' ? 'revoked' : 'active' };
  } catch {
    // Unparseable is not a binding — the same call readParentBinding makes.
    return { present: false, state: null };
  }
}
