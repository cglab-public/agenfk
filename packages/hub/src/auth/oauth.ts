import { randomBytes, randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { DB } from '../db.js';
import { setSessionCookie, signSession, cookieSecure } from './session.js';
import { recordLogin, UserRow } from './password.js';
import { SessionPayload } from '../types.js';
import { recordAudit } from '../services/configAudit.js';

export const OAUTH_STATE_COOKIE = 'agenfk_hub_oauth_state';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AllowlistResult { allowed: boolean; reason?: string }

/**
 * A stored JSON list of strings (auth_config.email_allowlist,
 * auth_config.google_hosted_domains). An empty column is an empty list; any
 * other shape is null, which every caller treats as "admit nobody": the admin
 * route only stores arrays of strings, so anything else is a hand edit or an
 * older build, and sign-in must not open up because of it.
 */
export function parseStoredList(json: string | null): string[] | null {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    if (!Array.isArray(list) || !list.every(v => typeof v === 'string')) return null;
    return list;
  } catch {
    return null;
  }
}

export function checkEmailAllowlist(email: string, allowlistJson: string | null): AllowlistResult {
  const list = parseStoredList(allowlistJson);
  if (list === null) return { allowed: false, reason: 'The sign-in allowlist is unreadable; an admin must save it again' };
  if (list.length === 0) return { allowed: true };
  const lower = email.toLowerCase();
  for (const pattern of list) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.') && lower.endsWith(p.slice(1))) return { allowed: true };
    if (p.startsWith('@') && lower.endsWith(p)) return { allowed: true };
    if (lower.endsWith('@' + p)) return { allowed: true };
    if (lower === p) return { allowed: true };
  }
  return { allowed: false, reason: `Email ${email} not in allowlist` };
}

/**
 * Whether a Google account's hd claim is one of the stored Workspace domains.
 * An empty list admits every account, as before the list existed.
 */
export function checkHostedDomain(hd: string | undefined, domainsJson: string | null): AllowlistResult {
  const list = parseStoredList(domainsJson);
  if (list === null) return { allowed: false, reason: 'The Google Workspace domain list is unreadable; an admin must save it again' };
  if (list.length === 0) return { allowed: true };
  const claimed = typeof hd === 'string' ? hd.trim().toLowerCase() : '';
  if (claimed && list.some(d => d.toLowerCase() === claimed)) return { allowed: true };
  return { allowed: false, reason: 'This Google account is not in a Workspace domain this hub accepts' };
}

export function issueOAuthState(res: Response): string {
  const state = randomBytes(24).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', secure: cookieSecure(res.req),
    maxAge: OAUTH_STATE_TTL_MS, path: '/',
  });
  return state;
}

export function verifyOAuthState(req: Request, given: string | undefined): boolean {
  const cookie = req.cookies?.[OAUTH_STATE_COOKIE];
  return !!cookie && !!given && cookie === given;
}

export interface SsoIdentity {
  provider: 'google' | 'entra';
  subject: string;
  email: string;
  /** Display name as the provider reported it, when it reported one. */
  name?: string | null;
}

/**
 * A usable display name, or null. Providers do send whitespace-only values,
 * and storing one would replace a good name with something that renders as an
 * empty sidebar — worse than the UUID it was meant to fix.
 */
function usableName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  // The value is tenant-controlled at the provider, so bound it and drop
  // control characters (newlines, and bidi overrides that can reorder the
  // text around it) before it becomes a label we render.
  const cleaned = Array.from(name).filter((ch) => {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return false;       // C0 controls and DEL
    if (c >= 0x200e && c <= 0x200f) return false;   // LRM / RLM
    if (c >= 0x202a && c <= 0x202e) return false;   // bidi embedding and override
    if (c >= 0x2066 && c <= 0x2069) return false;   // bidi isolates
    return true;
  }).join('').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : null;
}

/** The row bound to this provider identity, the only way a bound row is ever matched. */
const findBySubject = (db: DB, identity: SsoIdentity) =>
  db.get<UserRow>('SELECT * FROM users WHERE provider = ? AND provider_subject = ?', [identity.provider, identity.subject]);

export type SsoLookup =
  | { user: UserRow }
  | { refused: 'not-invited' | 'bound-elsewhere' };

/** The 403 message for a refused lookup, the same for every provider. */
export function ssoRefusal(r: { refused: 'not-invited' | 'bound-elsewhere' }): string {
  return r.refused === 'bound-elsewhere'
    ? 'This email belongs to an account linked to another sign-in identity; ask your admin to reset your sign-in'
    : 'Account not invited — ask your admin to invite you first';
}

/**
 * Look up an SSO user that an admin has previously invited: a row matching the
 * provider+subject pair, or a row with that email that no sign-in identity has
 * claimed yet. Anything else is refused, never auto-provisioned.
 *
 * On first SSO sign-in for an email-invited user, the row is upgraded in
 * place (provider flips to the SSO provider, subject is filled in) and the
 * binding is audited. The user keeps their id and role.
 *
 * A row already bound to a subject is never rebound by email. Email is a
 * display claim at the provider: an address can be reused after its owner
 * leaves, and a new account carrying it must not inherit the old row's role.
 */
export async function findInvitedSsoUser(
  db: DB,
  orgId: string,
  identity: SsoIdentity,
  ip: string | null = null,
): Promise<SsoLookup> {
  // The provider owns the name, so refresh it on every sign-in — people get
  // married, change teams, fix a typo in their own profile. Only a usable
  // name overwrites what is stored.
  const name = usableName(identity.name);

  const existing = await findBySubject(db, identity);
  if (existing) {
    if (name && name !== existing.name) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [name, existing.id]);
      return { user: { ...existing, name } };
    }
    return { user: existing };
  }

  // Not scoped to orgId on purpose: users.email is UNIQUE across the whole
  // table and the hub creates one org, so an org filter adds nothing. The
  // subject lookup above is unscoped because the hub creates one org.
  const byEmail = await db.get<UserRow>(
    'SELECT * FROM users WHERE lower(email) = lower(?)',
    [identity.email],
  );
  if (!byEmail) return { refused: 'not-invited' };
  // A row back on a password account (admin recovery, or an admin's reset) is
  // unbound whatever subject an older build left on it.
  const bound = (u: UserRow) => !!u.provider_subject && u.provider !== 'password';
  if (bound(byEmail)) return { refused: 'bound-elsewhere' };

  const nextName = name ?? byEmail.name ?? null;
  // Conditional on the row still being unbound: two first sign-ins racing
  // for one invite must not both bind it, the second one winning.
  let result;
  try {
    result = await db.run(
      "UPDATE users SET provider = ?, provider_subject = ?, name = ? WHERE id = ? AND (provider_subject IS NULL OR provider = 'password')",
      [identity.provider, identity.subject, nextName, byEmail.id],
    );
  } catch (e) {
    // The subject index fired: another row took this identity between the lookup
    // and the bind. This attempt is refused and writes nothing; the next sign-in
    // finds that row by subject and signs in as it.
    if (isUniqueViolation(e)) return { refused: 'bound-elsewhere' };
    throw e;
  }
  if (result.changes !== 1) {
    // Lost the race. A double-submitted callback for the same identity bound
    // it first: that sign-in is the same person and gets the user.
    const winner = await findBySubject(db, identity);
    return winner ? { user: winner } : { refused: 'bound-elsewhere' };
  }
  await recordAudit(db, {
    orgId,
    actor: { userId: byEmail.id, email: byEmail.email },
    source: 'sso',
    ip,
    area: 'users',
    action: 'user.sso_bind',
    target: `user ${byEmail.email}`,
    before: { provider: byEmail.provider, providerSubject: byEmail.provider_subject ?? null },
    after: { provider: identity.provider, providerSubject: identity.subject },
  });
  return { user: { ...byEmail, provider: identity.provider, provider_subject: identity.subject, name: nextName } };
}

/** The role a member created by a first sign-in gets: sees the org, changes nothing (owner decision, INFRA-463). */
export const JIT_MEMBER_ROLE = 'viewer';

/**
 * Create the member for a first SSO sign-in that found no row, when the org's
 * join mode is auto and the caller has already applied every gate (tenant,
 * Workspace domain, allowlist, app role). Bound to the identity from the start,
 * so the row is never matched by email again, and marked as created by a
 * sign-in, so the callers keep holding it to the gate that let it in.
 *
 * Two callbacks for the same new identity can race: the email and the
 * (provider, subject) pair are both unique, so the second insert fails and that
 * sign-in gets the row the first one made, provided it is the same identity.
 * A unique violation on a taken email is refused as bound-elsewhere; any other
 * failure is the database's and is rethrown. The member and its audit entry are
 * one transaction, so a failed entry leaves no member and the next sign-in
 * makes both.
 */
export async function createSsoMember(
  db: DB,
  orgId: string,
  identity: SsoIdentity,
  ip: string | null = null,
): Promise<SsoLookup> {
  const name = usableName(identity.name);
  const id = randomUUID();
  let inserted = false;
  try {
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO users (id, org_id, email, name, password_hash, provider, provider_subject, role, active, join_source) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 'jit')",
        [id, orgId, identity.email, name, identity.provider, identity.subject, JIT_MEMBER_ROLE],
      );
      inserted = true;
      await recordAudit(db, {
        orgId,
        actor: { userId: id, email: identity.email },
        source: 'board',
        ip,
        area: 'users',
        action: 'user.jit_create',
        target: `user ${identity.email}`,
        before: null,
        after: { provider: identity.provider, providerSubject: identity.subject, role: JIT_MEMBER_ROLE },
      }, { rethrow: true });
    });
  } catch (e) {
    // The audit write failed: the transaction rolled the member back, and the
    // failure is the database's.
    if (inserted) throw e;
    if (!isUniqueViolation(e)) throw e;
    const winner = await findBySubject(db, identity);
    if (winner) return { user: winner };
    const byEmail = await db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower(?)', [identity.email]);
    if (byEmail) return { refused: 'bound-elsewhere' };
    throw e;
  }
  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return user ? { user } : { refused: 'not-invited' };
}

/**
 * A unique-index failure: Postgres 23505, or node:sqlite, which reports every
 * failure as code ERR_SQLITE_ERROR with the extended result code in errcode
 * (2067 for a unique index; 1555 primary key, 1299 NOT NULL and 275 CHECK are not).
 */
function isUniqueViolation(e: unknown): boolean {
  const { code, errcode } = (e ?? {}) as { code?: unknown; errcode?: unknown };
  return code === '23505' || errcode === 2067;
}

export async function completeSsoLogin(
  db: DB,
  res: Response,
  user: UserRow,
  sessionSecret: string,
): Promise<void> {
  await recordLogin(db, user.id);
  const payload: SessionPayload = { userId: user.id, orgId: user.org_id, role: user.role };
  setSessionCookie(res, signSession(payload, sessionSecret));
}
