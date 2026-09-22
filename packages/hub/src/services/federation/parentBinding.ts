import * as net from 'net';
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
 * Host NAMES a parent hub may not live on unless an operator says otherwise.
 * Addresses are judged separately, by range (isPrivateAddress): a regex over
 * address text kept missing spellings and whole ranges.
 *
 * The child fetches this URL with an admin-supplied value, so without a guard
 * the join form is a semi-blind SSRF probe: the route reflects the upstream
 * status and error body, which is enough to map internal ports. A LAN parent
 * is a legitimate deployment, so this is an opt-in rather than a hard no.
 */
const PRIVATE_NAME_RE = /^localhost$|\.localhost$|\.local$|\.internal$/i;

/** IPv4 ranges that are never a public host (RFC 6890 and friends). */
const PRIVATE_V4 = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE_V4.addSubnet(a, bits, 'ipv4');

/** IPv6 ranges that are never a public host. Embedded IPv4 is unwrapped first. */
const PRIVATE_V6 = new net.BlockList();
for (const [a, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) PRIVATE_V6.addSubnet(a, bits, 'ipv6');

/** An IPv6 address as eight 16-bit groups, or null. Zone ids are dropped. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, '').toLowerCase();
  // A trailing dotted quad (::ffff:1.2.3.4, ::1.2.3.4) becomes two groups.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (quad) {
    const b = quad.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = s.slice(0, quad.index) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');

/**
 * The IPv4 address an IPv6 one carries, where the network will actually
 * deliver to it: IPv4-mapped (::ffff:a.b.c.d), IPv4-translated
 * (::ffff:0:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96 - a
 * NAT gateway turns it back into that IPv4) and 6to4 (2002::/16).
 */
function embeddedIPv4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4From(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4From(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4From(g[6], g[7]);
  if (g[0] === 0x2002) return v4From(g[1], g[2]);
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4From(g[6], g[7]);
  return null;
}

/** Is this IP address (v4 or v6, any spelling) in a range that is never a public host? */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return PRIVATE_V4.check(bare, 'ipv4');
  const g = ipv6Groups(bare);
  if (!g) return true; // unparseable as an address: refuse rather than guess
  const v4 = embeddedIPv4(g);
  if (v4 !== null) return PRIVATE_V4.check(v4, 'ipv4');
  return PRIVATE_V6.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

export function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare.replace(/%.*$/, ''))) return isPrivateAddress(bare);
  return PRIVATE_NAME_RE.test(bare);
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
