import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { guardedLookup } from '../services/federation/guardedLookup';
import { httpFederationClient } from '../services/federation/federationClient';
import { httpTransport } from '../services/federation/federationSync';
import { assertHttpUrl } from '../services/federation/parentBinding';

/**
 * CGLAB-371 — a federation parent must not be reachable at a private address
 * through DNS.
 *
 * The admin-supplied parent URL was checked by HOSTNAME (isPrivateHost): a
 * public name resolving to 10.x, or one that changed its answer after the
 * check (DNS rebinding), was dialled wherever it pointed at connect time. The
 * check now runs on the socket's own lookup, so the address judged is the
 * address dialled - and a refusal happens before a single byte, the invite
 * token included, is sent.
 */

type Addr = { address: string; family: number };
/** A resolver that answers from a table instead of the network. */
const table = (answers: Record<string, Addr[]>) =>
  (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: Addr[]) => void) => {
    const a = answers[host];
    if (!a) cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), []);
    else cb(null, a);
  };

/** Run a Node-style lookup to completion. */
const lookupOf = (lookup: any, host: string, options: object = {}) =>
  new Promise<{ err: any; address?: any; family?: number }>((resolve) => {
    lookup(host, options, (err: any, address?: any, family?: number) => resolve({ err, address, family }));
  });

const PUBLIC = { address: '203.0.113.7', family: 4 };

describe('guardedLookup (CGLAB-371)', () => {
  it('refuses a public name that resolves to a private address', async () => {
    const lookup = guardedLookup({ allowPrivate: () => false, resolve: table({ 'parent.example.test': [{ address: '10.0.0.5', family: 4 }] }) });
    const r = await lookupOf(lookup, 'parent.example.test');
    expect(r.err?.code).toBe('EPRIVATEADDR');
    expect(r.err.message).toContain('parent.example.test');
    expect(r.err.message).toContain('AGENFK_HUB_ALLOW_PRIVATE_PARENT');
  });

  it('refuses when ANY of the addresses is private - the socket may pick that one', async () => {
    const lookup = guardedLookup({ allowPrivate: () => false, resolve: table({ 'mixed.example.test': [PUBLIC, { address: '192.168.1.9', family: 4 }] }) });
    expect((await lookupOf(lookup, 'mixed.example.test')).err?.code).toBe('EPRIVATEADDR');
  });

  it('refuses loopback, link-local, IPv6 unique-local and IPv4-mapped loopback', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', 'fd00::1', '::1', '::ffff:127.0.0.1']) {
      const lookup = guardedLookup({ allowPrivate: () => false, resolve: table({ h: [{ address, family: address.includes(':') ? 6 : 4 }] }) });
      expect((await lookupOf(lookup, 'h')).err?.code, address).toBe('EPRIVATEADDR');
    }
  });

  it('lets a public address through, in both callback shapes Node uses', async () => {
    const lookup = guardedLookup({ allowPrivate: () => false, resolve: table({ 'hub.example.test': [PUBLIC] }) });
    const single = await lookupOf(lookup, 'hub.example.test');
    expect(single.err).toBeNull();
    expect(single.address).toBe('203.0.113.7');
    expect(single.family).toBe(4);
    // Happy Eyeballs (autoSelectFamily) asks with all: true and wants the list.
    const all = await lookupOf(lookup, 'hub.example.test', { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([PUBLIC]);
  });

  it('allows a private parent when the operator opted in', async () => {
    const lookup = guardedLookup({ allowPrivate: () => true, resolve: table({ 'parent.lan': [{ address: '10.0.0.5', family: 4 }] }) });
    const r = await lookupOf(lookup, 'parent.lan');
    expect(r.err).toBeNull();
    expect(r.address).toBe('10.0.0.5');
  });

  it('passes a resolution failure through unchanged', async () => {
    const lookup = guardedLookup({ allowPrivate: () => false, resolve: table({}) });
    expect((await lookupOf(lookup, 'nowhere.example.test')).err?.code).toBe('ENOTFOUND');
  });
});

describe('the federation HTTP clients dial through the guard (CGLAB-371)', () => {
  let server: http.Server | null = null;
  let hits = 0;
  const saved = process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;

  const listen = async () => {
    hits = 0;
    server = http.createServer((_req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end('{"token":"t","childHubId":"c"}'); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return (server.address() as AddressInfo).port;
  };

  afterEach(async () => {
    if (saved === undefined) delete process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;
    else process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT = saved;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('refuses to enrol with a parent whose name resolves to loopback - and sends it nothing', async () => {
    // `localhost` resolves locally (no network), to a loopback address: the
    // same shape as a public name pointed at an internal one.
    delete process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;
    const port = await listen();
    const err: any = await httpFederationClient()
      .enroll({ parentUrl: `http://localhost:${port}`, inviteToken: 'secret-invite', name: 'child' })
      .then(() => null, (e) => e);
    expect(err, 'the enrolment went through').not.toBeNull();
    expect(err.code).toBe('EPRIVATEADDR');
    expect(hits, 'the invite reached the server').toBe(0);
  });

  it('enrols with a private parent once the operator opted in', async () => {
    process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT = '1';
    const port = await listen();
    const out = await httpFederationClient()
      .enroll({ parentUrl: `http://localhost:${port}`, inviteToken: 'secret-invite', name: 'child' });
    expect(out).toMatchObject({ token: 't', childHubId: 'c' });
    expect(hits).toBe(1);
  });

  it('guards the background transport too - ping, directives and deliver', async () => {
    delete process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;
    const port = await listen();
    const t = httpTransport();
    const target = { parentUrl: `http://localhost:${port}`, token: 'bearer' };
    for (const run of [
      () => t.ping({ ...target, hubVersion: '1' }),
      () => t.directives(target),
      () => t.deliver([], target),
    ]) {
      const err: any = await run().then(() => null, (e: any) => e);
      expect(err?.code).toBe('EPRIVATEADDR');
    }
    expect(hits, 'the bearer token reached the server').toBe(0);
  });

});

// ── review round 1 ─────────────────────────────────────────────────────────

describe('which resolved addresses count as private (CGLAB-371 review, F2)', () => {
  const PRIVATE = [
    '100.100.100.200', '100.64.0.1',            // CGNAT - incl. a cloud metadata service
    '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.5',  // NAT64: translated back to IPv4 by the gateway
    '::ffff:0:a9fe:a9fe',                       // IPv4-translated
    '::7f00:1', '::127.0.0.1',                  // IPv4-compatible (deprecated)
    '2002:a9fe:a9fe::1',                        // 6to4 of 169.254.169.254
    'fec0::1',                                  // site-local
    '0.1.2.3', '198.18.0.1', '192.0.0.8',       // "this network", benchmarking, IETF protocol
    '224.0.0.1', '255.255.255.255',             // multicast, broadcast
  ];
  const PUBLIC_ADDRS = [
    '8.8.8.8', '203.0.113.7', '2606:4700::1111', '::ffff:8.8.8.8', 'fe00::1',
    '64:ff9b::808:808',                         // NAT64 of a PUBLIC address
    '2002:808:808::1',                          // 6to4 of a PUBLIC address
  ];
  const judge = (address: string) => lookupOf(
    guardedLookup({ allowPrivate: () => false, resolve: table({ h: [{ address, family: address.includes(':') ? 6 : 4 }] }) }),
    'h',
  );

  it('refuses every private range a resolved address can land in', async () => {
    for (const address of PRIVATE) expect((await judge(address)).err?.code, address).toBe('EPRIVATEADDR');
  });

  it('still lets public addresses through, including their embedded-IPv4 spellings', async () => {
    for (const address of PUBLIC_ADDRS) expect((await judge(address)).err, address).toBeNull();
  });

  it('closes the same gaps for a parent URL written as an IP literal (which skips DNS)', () => {
    for (const host of ['http://100.100.100.200', 'http://[64:ff9b::a9fe:a9fe]', 'http://[2002:a9fe:a9fe::1]', 'http://198.18.0.1']) {
      expect(() => assertHttpUrl(host), host).toThrow(/private or loopback/i);
    }
    for (const host of ['http://[64:ff9b::808:808]', 'http://8.8.8.8']) expect(() => assertHttpUrl(host), host).not.toThrow();
  });
});

describe('what a refusal says (CGLAB-371 review, F3)', () => {
  it('does not tell the admin which private address a name resolved to, but logs it', async () => {
    // On a multi-org hub an org admin is not the operator: echoing the
    // address would turn the check into an oracle for internal DNS.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await lookupOf(
        guardedLookup({ allowPrivate: () => false, resolve: table({ 'db.corp.example': [{ address: '10.20.30.40', family: 4 }] }) }),
        'db.corp.example',
      );
      expect(r.err?.code).toBe('EPRIVATEADDR');
      expect(r.err.message).not.toContain('10.20.30.40');
      expect(warn.mock.calls.flat().join(' ')).toContain('10.20.30.40');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('end to end, through the real client (CGLAB-371 review, F1 + F7)', () => {
  const saved = { allow: process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT, http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, lower: process.env.http_proxy };
  const servers: http.Server[] = [];
  /** A listening server that counts CONNECTIONS, not requests: nothing sent means nothing connected. */
  const counting = async () => {
    const s = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"token":"t","childHubId":"c"}'); });
    const n = { connections: 0, requests: 0 };
    s.on('connection', () => { n.connections++; });
    s.on('request', () => { n.requests++; });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    servers.push(s);
    return { port: (s.address() as AddressInfo).port, n };
  };
  afterEach(async () => {
    for (const [k, v] of [['AGENFK_HUB_ALLOW_PRIVATE_PARENT', saved.allow], ['HTTP_PROXY', saved.http], ['HTTPS_PROXY', saved.https], ['http_proxy', saved.lower]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('refuses a PUBLIC-looking name that resolves to loopback - a check of the name alone would pass it', async () => {
    delete process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;
    const target = await counting();
    const resolve = table({ 'parent.example.test': [{ address: '127.0.0.1', family: 4 }] });
    const err: any = await httpFederationClient(undefined, { resolve })
      .enroll({ parentUrl: `http://parent.example.test:${target.port}`, inviteToken: 'secret-invite', name: 'child' })
      .then(() => null, (e) => e);
    expect(err?.code).toBe('EPRIVATEADDR');
    expect(err.message).toContain('refusing to connect');
    expect(target.n.connections, 'a socket was opened to the private address').toBe(0);
  });

  it('dials the parent DIRECTLY even with an HTTP proxy configured - the proxy would resolve the name itself', async () => {
    const target = await counting();
    const proxy = await counting();
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
    const resolve = table({ 'parent.example.test': [{ address: '127.0.0.1', family: 4 }] });

    // Without the opt-in: refused, and nothing reaches the proxy either.
    delete process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT;
    const refused: any = await httpTransport(undefined, { resolve })
      .ping({ parentUrl: `http://parent.example.test:${target.port}`, token: 'bearer', hubVersion: '1' })
      .then(() => null, (e) => e);
    expect(refused?.code).toBe('EPRIVATEADDR');
    expect(proxy.n.connections, 'the bearer token went to the proxy').toBe(0);

    // Opted in: it reaches the parent, and still not through the proxy.
    process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT = '1';
    await httpFederationClient(undefined, { resolve })
      .enroll({ parentUrl: `http://parent.example.test:${target.port}`, inviteToken: 'secret-invite', name: 'child' });
    expect(target.n.requests).toBe(1);
    expect(proxy.n.connections, 'federation traffic went through the proxy').toBe(0);
  });
});
