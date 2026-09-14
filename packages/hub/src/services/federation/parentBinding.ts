import type { DB } from '../../db.js';
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
}

interface StoredBinding {
  parentUrl: string;
  encToken: string;
  childHubId: string;
  enrolledAt: string;
  state: BindingState;
}

/** Only http(s): the URL is fetched by the worker, so file:// and javascript: are refused. */
export function assertHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('parentUrl must be a valid http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('parentUrl must be an http(s) URL');
  }
  return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
}

export async function writeParentBinding(
  db: DB,
  secretKey: string,
  input: { parentUrl: string; token: string; childHubId: string; enrolledAt?: string; state?: BindingState },
): Promise<void> {
  const parentUrl = assertHttpUrl(input.parentUrl);
  const stored: StoredBinding = {
    parentUrl,
    encToken: encryptSecret(input.token, secretKey),
    childHubId: input.childHubId,
    enrolledAt: input.enrolledAt ?? new Date().toISOString(),
    state: input.state ?? 'active',
  };
  // One row, replaced — a hub has exactly one parent.
  await db.run('DELETE FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
  await db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [PARENT_BINDING_KEY, JSON.stringify(stored)]);
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
