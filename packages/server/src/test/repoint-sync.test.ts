/**
 * Repoint campaign — client side (CGLAB-66).
 *
 * A repoint directive carries a URL, which makes it a fleet-hijack primitive if
 * trusted blindly: a compromised or spoofed hub could point every installation
 * in an org at an endpoint it controls. So the client re-runs the same identity
 * checks `agenfk hub repoint` performs before rewriting hub.json, and refuses
 * anything outside the campaign's allowed host.
 *
 * Mirrors the injectable structure of upgradeSync.ts: every side effect is a
 * function argument, so these are behaviour tests over real control flow rather
 * than mocks of the module under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyRepointTarget, reconcileRepointDirective, __resetRepointInflight } from '../hub/repointSync';

const ORG = 'acme';
const TOKEN = 'agk_test';
const NEW_URL = 'https://hub.new.example';

/** A fake GET router keyed on path suffix. */
function makeGet(routes: Record<string, any>, onCall?: (url: string) => void) {
  return async (url: string) => {
    onCall?.(url);
    for (const [suffix, value] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        if (value instanceof Error) throw value;
        return { status: 200, data: value };
      }
    }
    const e: any = new Error(`no route for ${url}`);
    e.response = { status: 404, data: 'not found' };
    throw e;
  };
}

const healthyRoutes = {
  '/healthz': { service: 'agenfk-hub' },
  '/v1/ping': { ok: true, orgId: ORG },
};

describe('verifyRepointTarget', () => {
  const base = { targetUrl: NEW_URL, allowedHost: 'hub.new.example', token: TOKEN, orgId: ORG };

  it('accepts a target that identifies as our hub and our org', async () => {
    const r = await verifyRepointTarget({ ...base, getImpl: makeGet(healthyRoutes) });
    expect(r.ok).toBe(true);
  });

  it('refuses a non-https target', async () => {
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'http://hub.new.example', getImpl: makeGet(healthyRoutes),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/https/i);
  });

  it('refuses a malformed target', async () => {
    const r = await verifyRepointTarget({ ...base, targetUrl: 'not-a-url', getImpl: makeGet(healthyRoutes) });
    expect(r.ok).toBe(false);
  });

  it('refuses a host outside the campaign allow-list', async () => {
    // The hijack case: a directive naming an attacker-controlled host.
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'https://evil.example', getImpl: makeGet(healthyRoutes),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/host/i);
  });

  it('does not call the target at all when the URL is already refused', async () => {
    const seen: string[] = [];
    await verifyRepointTarget({
      ...base, targetUrl: 'https://evil.example', getImpl: makeGet(healthyRoutes, u => seen.push(u)),
    });
    expect(seen).toEqual([]);
  });

  it('refuses when /healthz does not identify as agenfk-hub', async () => {
    const r = await verifyRepointTarget({
      ...base,
      getImpl: makeGet({ ...healthyRoutes, '/healthz': { service: 'something-else' } }),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/agenfk-hub/);
  });

  it('refuses when /healthz answers HTML (captive portal)', async () => {
    const r = await verifyRepointTarget({
      ...base, getImpl: makeGet({ ...healthyRoutes, '/healthz': '<html>login</html>' }),
    });
    expect(r.ok).toBe(false);
  });

  it('refuses when /healthz is unreachable', async () => {
    const r = await verifyRepointTarget({
      ...base, getImpl: makeGet({ ...healthyRoutes, '/healthz': new Error('ECONNREFUSED') }),
    });
    expect(r.ok).toBe(false);
  });

  it('refuses when the carried-over token is not valid at the new endpoint', async () => {
    const r = await verifyRepointTarget({
      ...base, getImpl: makeGet({ ...healthyRoutes, '/v1/ping': new Error('401') }),
    });
    expect(r.ok).toBe(false);
  });

  it('refuses when the new endpoint reports a different org', async () => {
    const r = await verifyRepointTarget({
      ...base, getImpl: makeGet({ ...healthyRoutes, '/v1/ping': { ok: true, orgId: 'someone-else' } }),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/org/i);
  });

  it('checks identity before authentication, so a wrong-service target is named as such', async () => {
    // Both would fail; the message must point at the more fundamental problem.
    const r = await verifyRepointTarget({
      ...base,
      getImpl: makeGet({ '/healthz': { service: 'nginx' }, '/v1/ping': new Error('401') }),
    });
    expect((r as any).error).toMatch(/agenfk-hub/);
  });
});

describe('verifyRepointTarget private-address guard', () => {
  const base = { token: TOKEN, orgId: ORG };

  it.each([
    ['https://127.0.0.1', '127.0.0.1'],
    ['https://localhost', 'localhost'],
    ['https://10.1.2.3', '10.1.2.3'],
    ['https://192.168.0.9', '192.168.0.9'],
    ['https://172.16.4.5', '172.16.4.5'],
    ['https://169.254.169.254', '169.254.169.254'],
    ['https://hub.internal', 'hub.internal'],
  ])('refuses %s', async (url, host) => {
    // Every fleet machine would otherwise GET this with its live bearer token,
    // turning a campaign into an internal-host probe and a token-harvest.
    const r = await verifyRepointTarget({
      ...base, targetUrl: url, allowedHost: host, getImpl: makeGet(healthyRoutes),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/private|internal|loopback|link-local/i);
  });

  it('does not contact a refused private address', async () => {
    const seen: string[] = [];
    await verifyRepointTarget({
      ...base, targetUrl: 'https://10.0.0.1', allowedHost: '10.0.0.1',
      getImpl: makeGet(healthyRoutes, u => seen.push(u)),
    });
    expect(seen).toEqual([]);
  });

  it('still accepts an ordinary public hostname', async () => {
    const r = await verifyRepointTarget({
      ...base, targetUrl: NEW_URL, allowedHost: 'hub.new.example', getImpl: makeGet(healthyRoutes),
    });
    expect(r.ok).toBe(true);
  });
});

describe('verifyRepointTarget URL normalisation', () => {
  const base = { token: TOKEN, orgId: ORG, allowedHost: 'hub.new.example' };

  it('probes the origin, not a path built by string-chopping the raw input', async () => {
    // 'https://hub.new.example/?x=1' + '/healthz' would request '/?x=1/healthz'.
    const seen: string[] = [];
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'https://hub.new.example/?x=1',
      getImpl: makeGet(healthyRoutes, u => seen.push(u)),
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['https://hub.new.example/healthz', 'https://hub.new.example/v1/ping']);
  });

  it('refuses a target carrying userinfo', async () => {
    // https://evil@hub.new.example passes a naive host check while sending
    // basic-auth credentials to the real hub.
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'https://evil@hub.new.example', getImpl: makeGet(healthyRoutes),
    });
    expect(r.ok).toBe(false);
  });

  it('compares hosts case-insensitively', async () => {
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'https://HUB.New.Example', getImpl: makeGet(healthyRoutes),
    });
    expect(r.ok).toBe(true);
  });

  it('is not fooled by a suffix-extended host', async () => {
    const r = await verifyRepointTarget({
      ...base, targetUrl: 'https://hub.new.example.evil.test', getImpl: makeGet(healthyRoutes),
    });
    expect(r.ok).toBe(false);
  });
});

describe('reconcileRepointDirective', () => {
  let written: any[];
  let events: any[];
  let flushed: number;

  const baseArgs = () => ({
    hubUrl: 'https://hub.old.example',
    hubToken: TOKEN,
    orgId: ORG,
    installationId: 'inst-1',
    envHubUrl: null as string | null,
    writeConfigImpl: (cfg: any) => { written.push(cfg); },
    recordEvent: (e: any) => { events.push(e); },
    flushNow: async () => { flushed++; },
    getImpl: makeGet(healthyRoutes),
  });

  const directive = { campaignId: 'camp-1', targetUrl: NEW_URL, allowedHost: 'hub.new.example' };
  const fetchOk = async () => ({ status: 200, json: async () => directive });
  const fetch204 = async () => ({ status: 204, json: async () => ({}) });

  beforeEach(() => {
    written = [];
    events = [];
    flushed = 0;
    __resetRepointInflight();
  });

  it('does nothing when there is no campaign', async () => {
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetch204 });
    expect(written).toEqual([]);
    expect(events).toEqual([]);
  });

  it('writes the new config and reports success', async () => {
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetchOk });

    expect(written).toEqual([{ url: NEW_URL, token: TOKEN, orgId: ORG }]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hub:repoint:succeeded');
    expect(events[0].payload).toMatchObject({ campaignId: 'camp-1', url: NEW_URL });
  });

  it('rebuilds the transport before flushing, so the confirmation reaches the NEW host', async () => {
    // The hub only believes a success that arrives on the target hostname. The
    // flusher's baseURL is fixed at construction and nothing re-reads hub.json,
    // so without an explicit rebuild the report goes to the OLD host, is
    // refused, and the target is reset to pending — forever.
    const order: string[] = [];
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: fetchOk,
      writeConfigImpl: () => { order.push('write'); },
      rebuildTransportImpl: async (cfg: any) => { order.push(`rebuild:${cfg.url}`); },
      recordEvent: () => { order.push('record'); },
      flushNow: async () => { order.push('flush'); },
    });

    expect(order).toEqual(['write', `rebuild:${NEW_URL}`, 'record', 'flush']);
  });

  it('does not report success at all if the transport cannot be rebuilt', async () => {
    // Reporting into the old host would have the hub reset us to pending; worse,
    // the board would show an error the admin cannot act on. Better to stay
    // pending silently and retry on the next tick.
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: fetchOk,
      rebuildTransportImpl: async () => { throw new Error('cannot rebuild'); },
    });

    expect(events).toEqual([]);
  });

  it('reports blocked and writes nothing when AGENFK_HUB_URL overrides hub.json', async () => {
    await reconcileRepointDirective({
      ...baseArgs(), fetchImpl: fetchOk, envHubUrl: 'https://hub.pinned.example',
    });

    // Writing the file would change nothing, so claiming success would make the
    // board report a machine as moved while it keeps using the old name.
    expect(written).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hub:repoint:blocked');
    expect(String(events[0].payload.reason)).toMatch(/AGENFK_HUB_URL/);
  });

  it('reports failed and writes nothing when the target fails verification', async () => {
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: fetchOk,
      getImpl: makeGet({ ...healthyRoutes, '/healthz': { service: 'nginx' } }),
    });

    expect(written).toEqual([]);
    expect(events[0].type).toBe('hub:repoint:failed');
    expect(String(events[0].payload.error)).toMatch(/agenfk-hub/);
  });

  it('refuses a directive whose target is outside its own allowed host', async () => {
    // Defense in depth: the hub sets allowedHost from the target URL, so a
    // mismatch means the directive was tampered with in transit.
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ campaignId: 'camp-1', targetUrl: 'https://evil.example', allowedHost: 'hub.new.example' }),
      }),
    });

    expect(written).toEqual([]);
    expect(events[0].type).toBe('hub:repoint:failed');
  });

  it('ignores a malformed directive body without reporting anything', async () => {
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: async () => ({ status: 200, json: async () => ({ campaignId: 'camp-1' }) }),
    });
    expect(written).toEqual([]);
    expect(events).toEqual([]);
  });

  it('ignores a non-200/204 response', async () => {
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
    });
    expect(written).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not repoint to the URL it is already using', async () => {
    await reconcileRepointDirective({
      ...baseArgs(),
      hubUrl: NEW_URL,
      fetchImpl: fetchOk,
    });

    // Already there — re-writing is pointless, but the hub still needs the
    // confirmation to mark the target succeeded.
    expect(written).toEqual([]);
    expect(events[0].type).toBe('hub:repoint:succeeded');
  });

  it('survives a fetch failure without throwing or writing', async () => {
    await expect(reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: async () => { throw new Error('network down'); },
    })).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  it('does not run two reconciles concurrently', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const slowFetch = async () => { calls++; await gate; return { status: 204, json: async () => ({}) }; };

    const a = reconcileRepointDirective({ ...baseArgs(), fetchImpl: slowFetch as any });
    const b = reconcileRepointDirective({ ...baseArgs(), fetchImpl: slowFetch as any });
    release();
    await Promise.all([a, b]);

    expect(calls).toBe(1);
  });

  it('releases the single-flight guard so later ticks still run', async () => {
    // Without the finally that clears it, one tick would silently stop this
    // install reconciling for the life of the process.
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetchOk });
    written = [];
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetchOk });

    expect(written).toHaveLength(1);
  });

  it('releases the guard even when the tick throws internally', async () => {
    await reconcileRepointDirective({
      ...baseArgs(),
      fetchImpl: fetchOk,
      recordEvent: () => { throw new Error('boom'); },
    }).catch(() => { /* the tick may surface it; the guard must still clear */ });

    written = [];
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetchOk });
    expect(written).toHaveLength(1);
  });

  it('stops repointing once it has followed the move', async () => {
    const args = { ...baseArgs(), fetchImpl: fetchOk, rebuildTransportImpl: async () => {} };

    await reconcileRepointDirective(args);
    __resetRepointInflight();
    await reconcileRepointDirective(args);

    // Second tick must not rewrite the file again — the reconciler follows its
    // own move rather than looping for the life of the campaign.
    expect(written).toHaveLength(1);
    // But it still confirms, because the hub needs the report to drain.
    expect(events.filter(e => e.type === 'hub:repoint:succeeded')).toHaveLength(2);
  });

  it('records the event against its own installation id', async () => {
    await reconcileRepointDirective({ ...baseArgs(), fetchImpl: fetchOk });
    expect(events[0].installationId).toBe('inst-1');
  });
});
