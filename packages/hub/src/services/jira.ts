import { createHash, randomBytes } from 'crypto';
import type { HubDb } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

/**
 * Hub-centralized JIRA (CGLAB-412).
 *
 * An admin registers the org's Atlassian OAuth 2.0 (3LO) app ONCE on the hub.
 * Every installation joined to the org then connects its OWN JIRA identity
 * through the hub, and the hub relays a read-only allow-list of JIRA calls
 * with the CALLER's token - so JIRA's permissions apply per person, and no
 * JIRA credential (neither the app secret nor anyone's token) reaches a
 * laptop. Connections are keyed by the hub api key that made them.
 *
 * Binding a token to a key happens in two halves, so a forged link cannot bind
 * a victim's JIRA account to an attacker's key: the callback holds the token
 * PENDING and hands the browser a one-time completion code on the loopback
 * callback of the installation that started the flow; only that same key can
 * redeem it. The code never reaches an attacker - it lands on the victim's own
 * machine - and the victim's machine holds a different key.
 */

export const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
export const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
export const JIRA_SCOPES = 'read:jira-user read:jira-work offline_access';
export const JIRA_HTTP_TIMEOUT_MS = 10_000;
export const MAX_CLIENT_ID_LENGTH = 256;
export const MAX_CLIENT_SECRET_LENGTH = 1024;
/** From start to Atlassian's callback: long enough to sign in and consent. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** From callback to the installation redeeming the code: a redirect's worth. */
export const OAUTH_COMPLETION_TTL_MS = 5 * 60 * 1000;

interface OrgJiraRow {
  org_id: string;
  client_id: string;
  client_secret_enc: string;
  updated_at: string;
}

interface ConnectionRow {
  key_hash: string;
  org_id: string;
  token_enc: string | null;
  cloud_id: string | null;
  cloud_url: string | null;
  account_email: string | null;
  connected_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface PendingRow {
  state: string;
  org_id: string;
  key_hash: string;
  return_to: string;
  completion_hash: string | null;
  token_enc: string | null;
  cloud_id: string | null;
  cloud_url: string | null;
  account_email: string | null;
  expires_at: string;
}

interface JiraTokens {
  access_token: string;
  refresh_token: string;
}

/** The org app as an admin sees it. No secret, by construction. */
export interface JiraAppView {
  configured: boolean;
  clientId: string;
  clientSecretSet: boolean;
  connectedCount: number;
}

/** One installation's connection as it may see it. No token, by construction. */
export interface JiraConnectionView {
  configured: boolean;
  connected: boolean;
  cloudId: string | null;
  cloudUrl: string | null;
  email: string | null;
  connectedAt: string | null;
  /** Why this connection stopped working (e.g. 'refresh_rejected'), until reconnected. */
  lastError: string | null;
}

/** Why a request could not be served, mapped to a status by the route. */
export class JiraRelayError extends Error {
  constructor(
    readonly code:
      | 'jira_not_configured'
      | 'jira_not_connected'
      | 'jira_auth_failed'
      | 'jira_unreachable'
      | 'invalid_return_to'
      | 'invalid_completion'
      | 'completion_key_mismatch'
      | 'key_not_personal',
    message: string,
  ) {
    super(message);
  }
}

/** Columns that make up a live connection, cleared together. */
const CLEAR_CONNECTION =
  'token_enc = NULL, cloud_id = NULL, cloud_url = NULL, account_email = NULL, connected_at = NULL';

const nowIso = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The REST base for one JIRA site, as Atlassian's 3LO gateway serves it. */
const siteApiBase = (cloudId: string) =>
  `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/`;

const readApp = (db: HubDb, orgId: string) =>
  db.get<OrgJiraRow>('SELECT * FROM org_jira WHERE org_id = ?', [orgId]);

const readConnection = (db: HubDb, orgId: string, keyHash: string) =>
  db.get<ConnectionRow>('SELECT * FROM jira_connections WHERE key_hash = ? AND org_id = ?', [keyHash, orgId]);

// ── the org app ─────────────────────────────────────────────────────────────

/**
 * Drop every connection and pending flow held by a revoked key. The key can
 * no longer use them, but a refresh token at rest is still a live credential
 * - an offboarded person's must not outlive their access. Called wherever a
 * key is revoked, and swept again whenever an admin looks.
 */
export async function purgeRevokedJiraConnections(db: HubDb, orgId: string): Promise<void> {
  const revoked = 'SELECT token_hash FROM api_keys WHERE org_id = ? AND revoked_at IS NOT NULL';
  await db.run(`DELETE FROM jira_connections WHERE org_id = ? AND key_hash IN (${revoked})`, [orgId, orgId]);
  await db.run(`DELETE FROM jira_oauth_pending WHERE org_id = ? AND key_hash IN (${revoked})`, [orgId, orgId]);
}

export async function getJiraApp(db: HubDb, orgId: string): Promise<JiraAppView> {
  await purgeRevokedJiraConnections(db, orgId);
  const app = await readApp(db, orgId);
  const n = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM jira_connections WHERE org_id = ? AND token_enc IS NOT NULL
       AND key_hash IN (SELECT token_hash FROM api_keys WHERE org_id = ? AND revoked_at IS NULL)`, [orgId, orgId]);
  return {
    configured: Boolean(app),
    clientId: app?.client_id ?? '',
    clientSecretSet: Boolean(app?.client_secret_enc),
    connectedCount: Number(n?.n ?? 0),
  };
}

/**
 * Save the org's Atlassian app. A blank secret keeps the stored one, since the
 * admin UI never echoes it back. A different client id drops every connection
 * and pending flow: a refresh token is bound to the app that issued it.
 */
export async function saveJiraApp(
  db: HubDb,
  orgId: string,
  opts: { clientId: string; clientSecret?: string; secretKey: string },
): Promise<void> {
  const existing = await readApp(db, orgId);
  if (!existing) {
    if (!opts.clientSecret) throw new Error('clientSecret is required');
    await db.run(
      'INSERT INTO org_jira (org_id, client_id, client_secret_enc, updated_at) VALUES (?, ?, ?, ?)',
      [orgId, opts.clientId, encryptSecret(opts.clientSecret, opts.secretKey), nowIso()],
    );
    return;
  }
  const secretEnc = opts.clientSecret ? encryptSecret(opts.clientSecret, opts.secretKey) : existing.client_secret_enc;
  await db.run(
    'UPDATE org_jira SET client_id = ?, client_secret_enc = ?, updated_at = ? WHERE org_id = ?',
    [opts.clientId, secretEnc, nowIso(), orgId],
  );
  if (opts.clientId !== existing.client_id) await disconnectAllJira(db, orgId);
}

export async function disconnectAllJira(db: HubDb, orgId: string): Promise<void> {
  await db.run('DELETE FROM jira_connections WHERE org_id = ?', [orgId]);
  await db.run('DELETE FROM jira_oauth_pending WHERE org_id = ?', [orgId]);
}

async function appCredentials(db: HubDb, orgId: string, secretKey: string) {
  const app = await readApp(db, orgId);
  if (!app) return null;
  return { clientId: app.client_id, clientSecret: decryptSecret(app.client_secret_enc, secretKey) };
}

// ── one installation's connection ───────────────────────────────────────────

export async function getJiraConnection(db: HubDb, orgId: string, keyHash: string): Promise<JiraConnectionView> {
  const app = await readApp(db, orgId);
  const row = await readConnection(db, orgId, keyHash);
  const connected = Boolean(app && row?.token_enc && row.cloud_id);
  return {
    configured: Boolean(app),
    connected,
    cloudId: connected ? row!.cloud_id : null,
    cloudUrl: connected ? row!.cloud_url : null,
    email: connected ? row!.account_email : null,
    connectedAt: connected ? row!.connected_at : null,
    lastError: row?.last_error ?? null,
  };
}

export async function disconnectJira(db: HubDb, orgId: string, keyHash: string): Promise<void> {
  await db.run('DELETE FROM jira_connections WHERE key_hash = ? AND org_id = ?', [keyHash, orgId]);
  // A flow this key left half-done may hold a token too.
  await db.run('DELETE FROM jira_oauth_pending WHERE key_hash = ? AND org_id = ?', [keyHash, orgId]);
}

/** Expired flows are dead weight, and some hold an encrypted token: drop them at every step. */
const sweepExpiredPending = (db: HubDb) =>
  db.run('DELETE FROM jira_oauth_pending WHERE expires_at < ?', [nowIso()]);

// ── per-user OAuth ──────────────────────────────────────────────────────────

/**
 * Where the browser may be sent back to: only the agenfk server on this
 * machine's loopback. Anything else would make the hub an open redirect - and
 * would hand the completion code to whoever owns the target.
 */
export function isLoopbackReturnTo(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 256) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash) return false;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
  return u.pathname === '/jira/oauth/callback';
}

async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(JIRA_HTTP_TIMEOUT_MS) });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const bearerHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });
const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

/** Begin a flow for this key: returns the Atlassian authorize URL to send the browser to. */
export async function startJiraOAuth(
  db: HubDb,
  opts: {
    orgId: string; keyHash: string; installationId: string | null;
    returnTo: unknown; redirectUri: string; secretKey: string;
  },
): Promise<string> {
  // A connection is one person's JIRA identity, keyed by the api key. A key
  // bound to no installation can be shared (a team or CI key handed out via
  // AGENFK_HUB_TOKEN), and every holder would then read JIRA as whoever
  // connected - and could complete each other's flows.
  if (!opts.installationId) {
    throw new JiraRelayError('key_not_personal', 'JIRA connects per installation; this hub key is not bound to one. Run `agenfk hub login` to get a personal key.');
  }
  if (!isLoopbackReturnTo(opts.returnTo)) {
    throw new JiraRelayError('invalid_return_to', 'returnTo must be this machine\'s agenfk /jira/oauth/callback on a loopback address');
  }
  const app = await appCredentials(db, opts.orgId, opts.secretKey);
  if (!app) {
    throw new JiraRelayError('jira_not_configured', 'JIRA is not configured on this hub. Ask a hub admin to configure it.');
  }
  await sweepExpiredPending(db);
  const state = randomBytes(24).toString('hex');
  await db.run(
    'INSERT INTO jira_oauth_pending (state, org_id, key_hash, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
    [state, opts.orgId, opts.keyHash, opts.returnTo, new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()],
  );
  const url = new URL(ATLASSIAN_AUTHORIZE_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('scope', JIRA_SCOPES);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Atlassian's callback. Consumes the state (single use), and on success holds
 * the token PENDING behind a fresh completion code. Returns where to send the
 * browser, or null when the state is unknown or expired (nowhere safe to go).
 */
export async function handleJiraCallback(
  db: HubDb,
  opts: { state: unknown; code: unknown; error: unknown; redirectUri: string; secretKey: string },
): Promise<string | null> {
  if (typeof opts.state !== 'string' || !opts.state) return null;
  await sweepExpiredPending(db);
  // Claim the state before the slow exchange: a reload or a retried request
  // for the same callback must not run a second exchange, whose failure (the
  // code is single-use) would otherwise delete the first one's result.
  const claim = await db.run(
    'UPDATE jira_oauth_pending SET claimed_at = ? WHERE state = ? AND claimed_at IS NULL AND completion_hash IS NULL AND expires_at >= ?',
    [nowIso(), opts.state, nowIso()],
  );
  if (claim.changes !== 1) return null;
  const pending = await db.get<PendingRow>('SELECT * FROM jira_oauth_pending WHERE state = ?', [opts.state]);
  if (!pending) return null;

  const back = (params: Record<string, string>) => {
    const u = new URL(pending.return_to);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const fail = async (reason: string) => {
    await db.run('DELETE FROM jira_oauth_pending WHERE state = ? AND completion_hash IS NULL', [pending.state]);
    return back({ error: reason });
  };

  if (typeof opts.error === 'string' && opts.error) return fail(opts.error.replace(/[^a-z_]/gi, '').slice(0, 64) || 'denied');
  if (typeof opts.code !== 'string' || !opts.code) return fail('missing_code');
  const app = await appCredentials(db, pending.org_id, opts.secretKey);
  if (!app) return fail('not_configured');

  try {
    const token = await fetchJson(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code: opts.code,
        redirect_uri: opts.redirectUri,
      }).toString(),
    });
    if (token.status !== 200 || !token.body?.access_token || !token.body?.refresh_token) return fail('token_exchange_failed');
    const tokens: JiraTokens = { access_token: token.body.access_token, refresh_token: token.body.refresh_token };

    const resources = await fetchJson(ATLASSIAN_RESOURCES_URL, { headers: bearerHeaders(tokens.access_token) });
    const site = Array.isArray(resources.body) ? resources.body[0] : undefined;
    if (resources.status !== 200 || !site?.id || !site?.url) return fail('no_accessible_site');

    const me = await fetchJson(`${siteApiBase(site.id)}myself`, { headers: bearerHeaders(tokens.access_token) });
    const email = me.status === 200 && typeof me.body?.emailAddress === 'string' ? me.body.emailAddress : null;

    const completion = randomBytes(32).toString('hex');
    await db.run(
      `UPDATE jira_oauth_pending SET completion_hash = ?, token_enc = ?, cloud_id = ?, cloud_url = ?,
         account_email = ?, expires_at = ? WHERE state = ?`,
      [sha256(completion), encryptSecret(JSON.stringify(tokens), opts.secretKey), site.id, site.url, email,
        new Date(Date.now() + OAUTH_COMPLETION_TTL_MS).toISOString(), pending.state],
    );
    return back({ completion });
  } catch {
    return fail('jira_unreachable');
  }
}

/**
 * The installation redeems its completion code. The code is burnt on ANY
 * attempt - a code presented by the wrong key has leaked, and must not stay
 * usable by anyone.
 */
export async function completeJiraOAuth(db: HubDb, orgId: string, keyHash: string, completion: unknown): Promise<void> {
  if (typeof completion !== 'string' || !/^[0-9a-f]{64}$/.test(completion)) {
    throw new JiraRelayError('invalid_completion', 'Invalid or expired JIRA connection code');
  }
  await sweepExpiredPending(db);
  const pending = await db.get<PendingRow>('SELECT * FROM jira_oauth_pending WHERE completion_hash = ?', [sha256(completion)]);
  if (!pending) throw new JiraRelayError('invalid_completion', 'Invalid or expired JIRA connection code');
  await db.run('DELETE FROM jira_oauth_pending WHERE state = ?', [pending.state]);
  if (pending.expires_at < nowIso() || !pending.token_enc) {
    throw new JiraRelayError('invalid_completion', 'Invalid or expired JIRA connection code');
  }
  if (pending.key_hash !== keyHash || pending.org_id !== orgId) {
    throw new JiraRelayError('completion_key_mismatch', 'This JIRA connection was started by a different installation');
  }
  const now = nowIso();
  await db.run('DELETE FROM jira_connections WHERE key_hash = ?', [keyHash]);
  await db.run(
    `INSERT INTO jira_connections (key_hash, org_id, token_enc, cloud_id, cloud_url, account_email, connected_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [keyHash, orgId, pending.token_enc, pending.cloud_id, pending.cloud_url, pending.account_email, now, now],
  );
}

// ── refresh ─────────────────────────────────────────────────────────────────

/**
 * One refresh per connection at a time. Atlassian rotates the refresh token on
 * every use, so two concurrent refreshes would have the second present a token
 * the first just invalidated - and the connection is dead for good.
 *
 * The Map only covers one process. Across hub replicas the database narrows
 * the race: the new token is written with a compare-and-swap on the ciphertext
 * that was refreshed, and a rejected refresh first checks whether another
 * replica already STORED a rotated token before declaring the grant dead. It
 * does not close it: a replica that rotated at Atlassian but has not written
 * yet can still lose to one that is refused in that window. The same CAS
 * stops an in-flight refresh from writing tokens back over a Disconnect.
 */
const refreshInFlight = new Map<string, Promise<JiraTokens>>();

const notConnected = () =>
  new JiraRelayError('jira_not_connected', 'JIRA is not connected for this installation. Connect JIRA from your board.');

async function refreshTokens(
  db: HubDb, orgId: string, keyHash: string, secretKey: string, stale: JiraTokens,
): Promise<JiraTokens> {
  const pending = refreshInFlight.get(keyHash);
  if (pending) return pending;
  const decode = (enc: string): JiraTokens => JSON.parse(decryptSecret(enc, secretKey));
  /** What is stored now, when it is no longer the ciphertext we started from. */
  const storedIfChanged = async (from: string): Promise<JiraTokens | null> => {
    const after = await readConnection(db, orgId, keyHash);
    if (!after?.token_enc) throw notConnected();
    return after.token_enc !== from ? decode(after.token_enc) : null;
  };

  const run = (async () => {
    const row = await readConnection(db, orgId, keyHash);
    if (!row?.token_enc) throw notConnected();
    const current = decode(row.token_enc);
    // Another request refreshed between our failure and now: use its token.
    if (current.access_token !== stale.access_token) return current;
    const app = await appCredentials(db, orgId, secretKey);
    if (!app) throw notConnected();

    const r = await fetchJson(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: current.refresh_token,
      }).toString(),
    });
    // Only an explicit OAuth refusal means the grant is dead. A 429 during a
    // post-expiry burst, a 5xx, an edge proxy's HTML page or a malformed 200
    // is Atlassian failing to answer: keep the connection and retry later -
    // clearing it would log out everyone who refreshed in that minute.
    const refused = [400, 401, 403].includes(r.status)
      && ['invalid_grant', 'unauthorized_client', 'access_denied'].includes(r.body?.error);
    if (!refused && (r.status !== 200 || !r.body?.access_token)) {
      throw new JiraRelayError('jira_unreachable', `Atlassian token endpoint did not answer (HTTP ${r.status})`);
    }
    if (refused) {
      const rotatedElsewhere = await storedIfChanged(row.token_enc);
      if (rotatedElsewhere) return rotatedElsewhere;
      // The grant is dead (app revoked, inactivity expiry, lost rotation).
      // Drop it, so status stops claiming "connected" and every request stops
      // re-trying a refresh that can never succeed.
      await db.run(
        `UPDATE jira_connections SET ${CLEAR_CONNECTION}, last_error = ?, updated_at = ? WHERE key_hash = ? AND token_enc = ?`,
        ['refresh_rejected', nowIso(), keyHash, row.token_enc],
      );
      throw new JiraRelayError('jira_auth_failed', 'JIRA rejected the token refresh; reconnect JIRA from your board');
    }
    const next: JiraTokens = {
      access_token: r.body.access_token,
      refresh_token: r.body.refresh_token ?? current.refresh_token,
    };
    const w = await db.run(
      'UPDATE jira_connections SET token_enc = ?, updated_at = ? WHERE key_hash = ? AND token_enc = ?',
      [encryptSecret(JSON.stringify(next), secretKey), nowIso(), keyHash, row.token_enc],
    );
    if (w.changes === 0) {
      // Disconnected or refreshed elsewhere meanwhile: what is stored now wins.
      return (await storedIfChanged(row.token_enc)) ?? next;
    }
    return next;
  })();
  refreshInFlight.set(keyHash, run);
  try {
    return await run;
  } finally {
    refreshInFlight.delete(keyHash);
  }
}

// ── the relay ───────────────────────────────────────────────────────────────

/**
 * The read-only JIRA surface installations may reach: exactly the calls the
 * local server makes (key validation, project list, issue search, import).
 * Anything else - comments, user search, writes - is not relayed.
 */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
export const MAX_RELAY_QUERY_LENGTH = 4096;

export function isRelayablePath(path: string): boolean {
  if (path === 'myself' || path === 'project/search' || path === 'search/jql') return true;
  const m = /^issue\/([^/]+)$/.exec(path);
  return Boolean(m && ISSUE_KEY_RE.test(m[1]));
}

/**
 * Relay one allow-listed GET to the caller's JIRA site with the CALLER's
 * token, refreshing once on a 401. Atlassian's status and body are returned
 * as-is so a client can tell "no such issue" (404) from "no access" (403).
 */
export async function relayJiraGet(
  db: HubDb,
  opts: { orgId: string; keyHash: string; secretKey: string; path: string; query: string },
): Promise<{ status: number; body: any }> {
  const app = await readApp(db, opts.orgId);
  const row = await readConnection(db, opts.orgId, opts.keyHash);
  if (!app || !row?.token_enc || !row.cloud_id) throw notConnected();
  let tokens: JiraTokens = JSON.parse(decryptSecret(row.token_enc, opts.secretKey));
  const url = `${siteApiBase(row.cloud_id)}${opts.path}${opts.query ? `?${opts.query}` : ''}`;
  const call = (t: JiraTokens) => fetchJson(url, { headers: bearerHeaders(t.access_token) });

  try {
    let r = await call(tokens);
    if (r.status === 401) {
      tokens = await refreshTokens(db, opts.orgId, opts.keyHash, opts.secretKey, tokens);
      r = await call(tokens);
      if (r.status === 401) {
        throw new JiraRelayError('jira_auth_failed', 'JIRA rejected the token; reconnect JIRA from your board');
      }
    }
    return r;
  } catch (e) {
    if (e instanceof JiraRelayError) throw e;
    throw new JiraRelayError('jira_unreachable', `JIRA unreachable: ${(e as Error).message}`);
  }
}
