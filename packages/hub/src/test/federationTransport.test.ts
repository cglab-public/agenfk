// The only code that talks to a real parent (CGLAB-181). It had no tests at
// all, so the bearer header, the endpoint paths, the timeout, the
// 204-means-nothing-to-do branch and the refusal to follow redirects were all
// unasserted.
import { describe, it, expect } from 'vitest';
import { httpTransport, FEDERATION_HTTP_TIMEOUT_MS } from '../services/federation/federationSync';

function fakeAxios(reply: (method: string, url: string, body: any, cfg: any) => any) {
  const calls: Array<{ method: string; url: string; body: any; cfg: any }> = [];
  return {
    calls,
    async post(url: string, body: any, cfg: any) { calls.push({ method: 'POST', url, body, cfg }); return reply('POST', url, body, cfg); },
    async get(url: string, cfg: any) { calls.push({ method: 'GET', url, body: undefined, cfg }); return reply('GET', url, undefined, cfg); },
  };
}

const creds = { parentUrl: 'https://parent.example.com', token: 'fed_abc' };

describe('httpTransport', () => {
  it('sends the bearer token, a bounded timeout, and never follows a redirect', async () => {
    const ax = fakeAxios(() => ({ status: 200, data: { ok: true } }));
    const t = httpTransport(ax);
    await t.ping({ ...creds, hubVersion: '1.2.3' });
    await t.directives(creds);
    await t.deliver([{ id: 'r1', kind: 'event', payload: {}, createdAt: 'x', attempts: 0, rejections: 0 }], creds);
    expect(ax.calls).toHaveLength(3);
    for (const c of ax.calls) {
      expect(c.cfg.headers.Authorization).toBe('Bearer fed_abc');
      expect(c.cfg.timeout).toBe(FEDERATION_HTTP_TIMEOUT_MS);
      // A parent that redirects could bounce the token, or re-POST the outbox
      // body somewhere else entirely.
      expect(c.cfg.maxRedirects).toBe(0);
    }
  });

  it('targets the federation endpoints on the bound parent', async () => {
    const ax = fakeAxios(() => ({ status: 200, data: {} }));
    const t = httpTransport(ax);
    await t.ping({ ...creds, hubVersion: '1.0.0' });
    await t.directives(creds);
    await t.deliver([], creds);
    expect(ax.calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST https://parent.example.com/v1/federation/ping',
      'GET https://parent.example.com/v1/federation/directives',
      'POST https://parent.example.com/v1/federation/deliver',
    ]);
    expect(ax.calls[0].body).toEqual({ hubVersion: '1.0.0' });
  });

  it('reads a 204 from /directives as nothing to do, not as an error', async () => {
    const ax = fakeAxios(() => ({ status: 204, data: '' }));
    const t = httpTransport(ax);
    await expect(t.directives(creds)).resolves.toBeNull();
    // and the status allowlist is narrow: anything else is axios's problem
    expect(ax.calls[0].cfg.validateStatus(200)).toBe(true);
    expect(ax.calls[0].cfg.validateStatus(204)).toBe(true);
    expect(ax.calls[0].cfg.validateStatus(404)).toBe(false);
    expect(ax.calls[0].cfg.validateStatus(500)).toBe(false);
  });

  it('returns the directive body on a 200', async () => {
    const ax = fakeAxios(() => ({ status: 200, data: { kind: 'flow-dispatch', id: 'd1' } }));
    const t = httpTransport(ax);
    await expect(t.directives(creds)).resolves.toEqual({ kind: 'flow-dispatch', id: 'd1' });
  });

  it('sends the outbox rows in the body of /deliver', async () => {
    const ax = fakeAxios(() => ({ status: 200, data: { accepted: 1 } }));
    const t = httpTransport(ax);
    const rows = [{ id: 'r1', kind: 'event', payload: { a: 1 }, createdAt: 'x', attempts: 0, rejections: 0 }];
    await t.deliver(rows, creds);
    expect(ax.calls[0].body).toEqual({ rows });
  });
});
