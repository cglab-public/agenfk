import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchHubJiraStatus,
  openHubJiraSession,
  clearHubJiraStatusCache,
  HubJiraError,
  HUB_JIRA_FAILURE_TTL_MS,
  startHubJiraOAuth,
  completeHubJiraOAuth,
  disconnectHubJira,
} from '../jira/hubJira';

/**
 * The local server's side of hub-centralized JIRA (CGLAB-412).
 *
 * A joined installation reaches JIRA only through its hub: the org's
 * connection lives there, and this module is the one place that talks to it.
 * Its errors mirror axios' `err.response.status` shape on purpose - the local
 * JIRA code already branches on that (404/403/400 = bad key, anything else =
 * unverified), and keeping the shape is what lets those branches work
 * unchanged for both sources.
 */

const HUB = { url: 'http://hub.example.test', token: 'agk_test' };

type Reply = { status: number; body?: unknown } | Error;

function stubFetch(routes: Record<string, Reply | ((url: string) => Reply)>) {
  const calls: Array<{ url: string; auth?: string; method: string; body?: any }> = [];
  const fn = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    calls.push({
      url, auth: init?.headers?.Authorization, method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) return { ok: false, status: 599, json: async () => ({}) };
    const route = routes[key];
    const reply = typeof route === 'function' ? route(url) : route;
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const CONNECTED = { configured: true, connected: true, cloudId: 'c1', cloudUrl: 'https://acme.atlassian.net', email: 'bot@acme.test' };

beforeEach(() => clearHubJiraStatusCache());
afterEach(() => vi.unstubAllGlobals());

describe('fetchHubJiraStatus', () => {
  it('asks the hub with the installation key and reports the org connection', async () => {
    const f = stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED } });
    const s = await fetchHubJiraStatus(HUB);
    expect(s).toEqual({ ...CONNECTED, source: 'hub', lastError: null });
    expect(f.calls[0].auth).toBe('Bearer agk_test');
  });

  it('caches briefly, so a polling board does not hit the hub on every render', async () => {
    const f = stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED } });
    await fetchHubJiraStatus(HUB);
    await fetchHubJiraStatus(HUB);
    expect(f.calls).toHaveLength(1);
    clearHubJiraStatusCache();
    await fetchHubJiraStatus(HUB);
    expect(f.calls).toHaveLength(2);
  });

  it('a rejected hub key is hub_auth_failed, not a JIRA problem', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 401, body: { error: 'Invalid or revoked token' } } });
    await expect(fetchHubJiraStatus(HUB)).rejects.toMatchObject({ code: 'hub_auth_failed' });
  });

  it('an unreachable hub is hub_unreachable', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: new Error('ECONNREFUSED') });
    await expect(fetchHubJiraStatus(HUB)).rejects.toMatchObject({ code: 'hub_unreachable' });
  });

  it('an older hub without the JIRA routes (404) reads as not configured', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 404, body: {} } });
    const s = await fetchHubJiraStatus(HUB);
    expect(s).toMatchObject({ source: 'hub', configured: false, connected: false });
  });

  it('remembers a failure only briefly: a down hub does not stall every poll, a recovered one is seen at once', async () => {
    let n = 0;
    const f = stubFetch({ [`${HUB.url}/v1/jira/status`]: () => (n++ === 0 ? new Error('down') : { status: 200, body: CONNECTED }) });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await expect(fetchHubJiraStatus(HUB)).rejects.toBeInstanceOf(HubJiraError);
    await expect(fetchHubJiraStatus(HUB)).rejects.toMatchObject({ code: 'hub_unreachable' });
    expect(f.calls).toHaveLength(1);
    now.mockReturnValue(t0 + HUB_JIRA_FAILURE_TTL_MS + 1);
    await expect(fetchHubJiraStatus(HUB)).resolves.toMatchObject({ connected: true });
    expect(f.calls).toHaveLength(2);
    now.mockRestore();
  });

  it('only an https site URL from the hub counts as a connection (it becomes every card\'s href)', async () => {
    for (const cloudUrl of ['javascript:alert(1)', 'http://acme.atlassian.net', 'https://user:pw@acme.atlassian.net', 'not a url']) {
      clearHubJiraStatusCache();
      stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: { ...CONNECTED, cloudUrl } } });
      const s = await fetchHubJiraStatus(HUB);
      expect(s.connected, cloudUrl).toBe(false);
      expect(s.cloudUrl, cloudUrl).toBeNull();
    }
  });

  it('passes the hub\'s lastError through, so the user learns the connection broke', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: { configured: true, connected: false, lastError: 'refresh_rejected' } } });
    expect(await fetchHubJiraStatus(HUB)).toMatchObject({ connected: false, lastError: 'refresh_rejected' });
  });
});

describe('openHubJiraSession', () => {
  it('is null when the org has no JIRA connection', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: { configured: true, connected: false } } });
    expect(await openHubJiraSession(HUB)).toBeNull();
  });

  it('carries the org site, so browse URLs point at the org\'s JIRA', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED } });
    const s = await openHubJiraSession(HUB);
    expect(s).toMatchObject({ source: 'hub', cloudId: 'c1', cloudUrl: 'https://acme.atlassian.net', email: 'bot@acme.test' });
  });

  it('get() relays through the hub with the installation key, never to Atlassian directly', async () => {
    const f = stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
      [`${HUB.url}/v1/jira/rest/api/3/`]: { status: 200, body: { key: 'ACME-1', fields: { summary: 'One' } } },
    });
    const s = (await openHubJiraSession(HUB))!;
    const { data } = await s.get('issue/ACME-1?fields=summary');
    expect(data.fields.summary).toBe('One');
    const relay = f.calls.at(-1)!;
    expect(relay.url).toBe(`${HUB.url}/v1/jira/rest/api/3/issue/ACME-1?fields=summary`);
    expect(relay.auth).toBe('Bearer agk_test');
    expect(relay.method).toBe('GET');
    expect(f.calls.some(c => c.url.includes('atlassian'))).toBe(false);
  });

  it('get() surfaces JIRA\'s status in axios shape (err.response.status)', async () => {
    stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
      [`${HUB.url}/v1/jira/rest/api/3/`]: { status: 404, body: { errorMessages: ['Issue does not exist'] } },
    });
    const s = (await openHubJiraSession(HUB))!;
    const err: any = await s.get('issue/ACME-9').catch(e => e);
    expect(err).toBeInstanceOf(HubJiraError);
    expect(err.response.status).toBe(404);
    expect(err.response.data.errorMessages[0]).toBe('Issue does not exist');
  });

  it('get() maps the hub\'s own refusals to codes a caller can act on', async () => {
    const cases: Array<[number, unknown, string]> = [
      [409, { code: 'jira_not_connected', error: 'x' }, 'jira_not_connected'],
      [502, { code: 'jira_auth_failed', error: 'x' }, 'jira_auth_failed'],
      [401, { error: 'Invalid or revoked token' }, 'hub_auth_failed'],
    ];
    for (const [status, body, code] of cases) {
      clearHubJiraStatusCache();
      stubFetch({
        [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
        [`${HUB.url}/v1/jira/rest/api/3/`]: { status, body },
      });
      const s = (await openHubJiraSession(HUB))!;
      const err: any = await s.get('myself').catch(e => e);
      expect(err.code, String(status)).toBe(code);
    }
  });

  it('a hub allow-list refusal never reads as "no such issue" (no response.status 404)', async () => {
    stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
      [`${HUB.url}/v1/jira/rest/api/3/`]: { status: 404, body: { code: 'not_relayed', error: 'Not a relayed JIRA endpoint' } },
    });
    const s = (await openHubJiraSession(HUB))!;
    const err: any = await s.get('issue/acme-1').catch(e => e);
    expect(err.code).toBe('not_relayed');
    expect(err.response?.status).toBeUndefined();
  });

  it('get() on an unreachable hub is hub_unreachable', async () => {
    stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
      [`${HUB.url}/v1/jira/rest/api/3/`]: new Error('ETIMEDOUT'),
    });
    const s = (await openHubJiraSession(HUB))!;
    await expect(s.get('myself')).rejects.toMatchObject({ code: 'hub_unreachable' });
  });

  it('strips a trailing slash from the hub url', async () => {
    const f = stubFetch({ [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED } });
    await fetchHubJiraStatus({ url: `${HUB.url}/`, token: HUB.token });
    expect(f.calls[0].url).toBe(`${HUB.url}/v1/jira/status`);
  });
});

describe('per-user OAuth through the hub', () => {
  const RETURN_TO = 'http://localhost:3000/jira/oauth/callback';

  it('start asks the hub, with this installation\'s key, for an authorize URL returning to our loopback callback', async () => {
    const f = stubFetch({ [`${HUB.url}/v1/jira/oauth/start`]: { status: 200, body: { authorizeUrl: 'https://auth.atlassian.com/authorize?state=s' } } });
    expect(await startHubJiraOAuth(HUB, RETURN_TO)).toBe('https://auth.atlassian.com/authorize?state=s');
    expect(f.calls[0]).toMatchObject({ method: 'POST', auth: 'Bearer agk_test', body: { returnTo: RETURN_TO } });
  });

  it('start maps the hub\'s refusal to a code (no app configured on the hub)', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/oauth/start`]: { status: 409, body: { code: 'jira_not_configured', error: 'x' } } });
    await expect(startHubJiraOAuth(HUB, RETURN_TO)).rejects.toMatchObject({ code: 'jira_not_configured' });
  });

  it('complete redeems the completion code with this installation\'s key, and clears the status cache', async () => {
    const f = stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: { configured: true, connected: false } },
      [`${HUB.url}/v1/jira/oauth/complete`]: { status: 200, body: CONNECTED },
    });
    await fetchHubJiraStatus(HUB);
    await completeHubJiraOAuth(HUB, 'c'.repeat(64));
    const call = f.calls.find(c => c.url.endsWith('/oauth/complete'))!;
    expect(call).toMatchObject({ method: 'POST', auth: 'Bearer agk_test', body: { completion: 'c'.repeat(64) } });
    await fetchHubJiraStatus(HUB);
    expect(f.calls.filter(c => c.url.endsWith('/status'))).toHaveLength(2);
  });

  it('complete surfaces a completion started by another installation', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/oauth/complete`]: { status: 403, body: { code: 'completion_key_mismatch', error: 'x' } } });
    await expect(completeHubJiraOAuth(HUB, 'c'.repeat(64))).rejects.toMatchObject({ code: 'completion_key_mismatch' });
  });

  it('disconnect drops this installation\'s connection on the hub and clears the status cache', async () => {
    const f = stubFetch({
      [`${HUB.url}/v1/jira/status`]: { status: 200, body: CONNECTED },
      [`${HUB.url}/v1/jira/disconnect`]: { status: 200, body: { configured: true, connected: false } },
    });
    await fetchHubJiraStatus(HUB);
    await disconnectHubJira(HUB);
    expect(f.calls.find(c => c.url.endsWith('/disconnect'))).toMatchObject({ method: 'POST', auth: 'Bearer agk_test' });
    await fetchHubJiraStatus(HUB);
    expect(f.calls.filter(c => c.url.endsWith('/status'))).toHaveLength(2);
  });

  it('an unreachable hub is hub_unreachable for all three', async () => {
    stubFetch({ [`${HUB.url}/v1/jira/`]: new Error('ECONNREFUSED') });
    await expect(startHubJiraOAuth(HUB, RETURN_TO)).rejects.toMatchObject({ code: 'hub_unreachable' });
    await expect(completeHubJiraOAuth(HUB, 'c'.repeat(64))).rejects.toMatchObject({ code: 'hub_unreachable' });
    await expect(disconnectHubJira(HUB)).rejects.toMatchObject({ code: 'hub_unreachable' });
  });
});
