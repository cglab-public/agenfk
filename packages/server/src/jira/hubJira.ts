/**
 * Hub-centralized JIRA, installation side (CGLAB-412).
 *
 * An installation joined to a hub reaches JIRA ONLY through the hub: a hub
 * admin registers the org's Atlassian app there, each user connects their OWN
 * JIRA identity through it, and the hub relays a read-only allow-list of JIRA
 * calls with that user's token, authenticated by this installation's hub key.
 * No JIRA credential ever reaches this machine, and a local `agenfk jira
 * setup` is ignored while joined - there is no fallback.
 *
 * Errors carry `response: { status, data }` like an axios error. The JIRA code
 * in server.ts already branches on `err.response?.status` (404/403/400 = the
 * key is wrong, anything else = JIRA could not answer), and keeping that shape
 * is what lets one code path serve both the hub and a local connection.
 */

export interface HubTarget {
  url: string;
  token: string;
}

export interface HubJiraStatus {
  source: 'hub';
  configured: boolean;
  connected: boolean;
  cloudId: string | null;
  cloudUrl: string | null;
  email: string | null;
  /** Why this user's connection stopped working (e.g. 'refresh_rejected'), until they reconnect. */
  lastError?: string | null;
}

/** An open JIRA connection, wherever it lives. `get` takes a path under rest/api/3/. */
export interface JiraSession {
  source: 'hub' | 'local';
  cloudId: string;
  cloudUrl: string;
  email?: string | null;
  get(apiPath: string, timeoutMs?: number): Promise<{ data: any }>;
}

export type HubJiraErrorCode =
  | 'hub_unreachable'
  | 'hub_auth_failed'
  | 'jira_not_configured'
  | 'jira_not_connected'
  | 'completion_key_mismatch'
  | 'invalid_completion'
  | 'invalid_return_to'
  | 'key_not_personal'
  | 'jira_auth_failed'
  | 'jira_unreachable'
  | 'not_relayed'
  | 'jira_error';

export class HubJiraError extends Error {
  readonly response?: { status: number; data: any };
  constructor(readonly code: HubJiraErrorCode, message: string, response?: { status: number; data: any }) {
    super(message);
    this.name = 'HubJiraError';
    this.response = response;
  }
}

export const HUB_JIRA_TIMEOUT_MS = 10_000;
/** The board polls /jira/status; a short cache keeps that off the hub. */
export const HUB_JIRA_STATUS_TTL_MS = 15_000;
/**
 * A failed status is remembered for a moment too: with the hub down, every
 * board poll and every `--jira-item` write would otherwise wait out the full
 * timeout. Short, so a recovered hub is noticed almost at once.
 */
export const HUB_JIRA_FAILURE_TTL_MS = 3_000;
/** The hub has no Atlassian app yet: only an admin can fix that. */
export const ASK_HUB_ADMIN = 'JIRA is not configured on your hub. Ask a hub admin to configure it.';
/** The app is there; this user just has not connected their own JIRA. */
export const CONNECT_FROM_BOARD = 'You have not connected your JIRA account. Use Connect JIRA on the board (it connects through your hub).';

const base = (hub: HubTarget) => hub.url.replace(/\/+$/, '');

async function hubGet(hub: HubTarget, path: string, timeoutMs: number): Promise<{ status: number; data: any }> {
  return hubRequest(hub, 'GET', path, undefined, timeoutMs);
}

async function hubRequest(
  hub: HubTarget, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number,
): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(`${base(hub)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${hub.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HubJiraError('hub_unreachable', `Hub unreachable: ${(e as Error).message}`);
  }
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

const statusCache = new Map<string, { at: number; value?: HubJiraStatus; error?: HubJiraError }>();

/**
 * The site URL becomes every card's browse link, rendered as an href. It now
 * comes from the hub rather than straight from Atlassian, so check it here:
 * https only, or it is treated as no site at all.
 */
function safeCloudUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? raw.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function clearHubJiraStatusCache(): void {
  statusCache.clear();
}

export async function fetchHubJiraStatus(hub: HubTarget): Promise<HubJiraStatus> {
  const cacheKey = `${base(hub)}\n${hub.token}`;
  const hit = statusCache.get(cacheKey);
  if (hit?.value && Date.now() - hit.at < HUB_JIRA_STATUS_TTL_MS) return hit.value;
  if (hit?.error && Date.now() - hit.at < HUB_JIRA_FAILURE_TTL_MS) throw hit.error;
  try {
    const value = await fetchHubJiraStatusUncached(hub);
    statusCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (e instanceof HubJiraError) statusCache.set(cacheKey, { at: Date.now(), error: e });
    throw e;
  }
}

async function fetchHubJiraStatusUncached(hub: HubTarget): Promise<HubJiraStatus> {
  const r = await hubGet(hub, '/v1/jira/status', HUB_JIRA_TIMEOUT_MS);
  if (r.status === 401 || r.status === 403) {
    throw new HubJiraError('hub_auth_failed', 'The hub rejected this installation\'s key. Run `agenfk hub login` again.');
  }
  let value: HubJiraStatus;
  if (r.status === 404) {
    // A hub from before CGLAB-412 has no JIRA routes: nothing is configured there.
    value = { source: 'hub', configured: false, connected: false, cloudId: null, cloudUrl: null, email: null };
  } else if (r.status !== 200 || !r.data) {
    throw new HubJiraError('hub_unreachable', `Hub JIRA status failed (HTTP ${r.status})`);
  } else {
    const cloudUrl = safeCloudUrl(r.data.cloudUrl);
    const connected = Boolean(r.data.connected && r.data.cloudId && cloudUrl);
    value = {
      source: 'hub',
      configured: Boolean(r.data.configured),
      connected,
      cloudId: connected ? String(r.data.cloudId) : null,
      cloudUrl: connected ? cloudUrl : null,
      email: connected && typeof r.data.email === 'string' ? r.data.email : null,
      lastError: typeof r.data.lastError === 'string' ? r.data.lastError : null,
    };
  }
  return value;
}

function relayError(status: number, data: any): HubJiraError {
  if (status === 401) {
    return new HubJiraError('hub_auth_failed', 'The hub rejected this installation\'s key.', { status, data });
  }
  const code = data?.code;
  if (code === 'not_relayed') {
    // The hub refused the path. No `response`: it must never read as JIRA
    // saying the issue does not exist.
    return new HubJiraError('not_relayed', 'The hub does not relay this JIRA request');
  }
  if (status === 409 && code === 'jira_not_connected') {
    return new HubJiraError('jira_not_connected', CONNECT_FROM_BOARD, { status, data });
  }
  if (status === 502 && (code === 'jira_auth_failed' || code === 'jira_unreachable')) {
    return new HubJiraError(code, data?.error || code, { status, data });
  }
  const detail = data?.errorMessages?.[0] || data?.error || `HTTP ${status}`;
  return new HubJiraError('jira_error', `JIRA request failed: ${detail}`, { status, data });
}

/**
 * This user's JIRA, held by the hub, as a session - or null when they have no
 * connection (or the hub has no app). Status
 * failures (hub down, key rejected) propagate - "cannot tell" is not
 * "not connected".
 */
export async function openHubJiraSession(hub: HubTarget): Promise<JiraSession | null> {
  const status = await fetchHubJiraStatus(hub);
  if (!status.connected || !status.cloudId || !status.cloudUrl) return null;
  return {
    source: 'hub',
    cloudId: status.cloudId,
    cloudUrl: status.cloudUrl,
    email: status.email,
    async get(apiPath: string, timeoutMs = HUB_JIRA_TIMEOUT_MS) {
      const r = await hubGet(hub, `/v1/jira/rest/api/3/${apiPath.replace(/^\/+/, '')}`, timeoutMs);
      if (r.status >= 200 && r.status < 300) return { data: r.data };
      throw relayError(r.status, r.data);
    },
  };
}

/** A hub-side refusal of an OAuth call, carried by its code (never an axios-shaped response). */
function oauthError(status: number, data: any): HubJiraError {
  if (status === 401) return new HubJiraError('hub_auth_failed', 'The hub rejected this installation\'s key.');
  const known: HubJiraErrorCode[] = [
    'jira_not_configured', 'completion_key_mismatch', 'invalid_completion', 'invalid_return_to', 'key_not_personal',
  ];
  const code = known.includes(data?.code) ? data.code as HubJiraErrorCode : 'jira_error';
  return new HubJiraError(code, data?.error || `Hub JIRA request failed (HTTP ${status})`);
}

/**
 * Begin connecting THIS user's JIRA: the hub records a flow bound to this
 * installation's key and returns the Atlassian URL to send the browser to.
 * `returnTo` is this server's loopback callback - where the hub will send the
 * browser back with a one-time completion code.
 */
export async function startHubJiraOAuth(hub: HubTarget, returnTo: string): Promise<string> {
  const r = await hubRequest(hub, 'POST', '/v1/jira/oauth/start', { returnTo }, HUB_JIRA_TIMEOUT_MS);
  if (r.status === 200 && typeof r.data?.authorizeUrl === 'string') return r.data.authorizeUrl;
  throw oauthError(r.status, r.data);
}

/** Redeem the completion code with this installation's key, binding the token to it. */
export async function completeHubJiraOAuth(hub: HubTarget, completion: string): Promise<void> {
  const r = await hubRequest(hub, 'POST', '/v1/jira/oauth/complete', { completion }, HUB_JIRA_TIMEOUT_MS);
  clearHubJiraStatusCache();
  if (r.status !== 200) throw oauthError(r.status, r.data);
}

/** Drop THIS user's connection on the hub. */
export async function disconnectHubJira(hub: HubTarget): Promise<void> {
  const r = await hubRequest(hub, 'POST', '/v1/jira/disconnect', undefined, HUB_JIRA_TIMEOUT_MS);
  clearHubJiraStatusCache();
  if (r.status !== 200) throw oauthError(r.status, r.data);
}
