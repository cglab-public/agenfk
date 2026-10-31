/**
 * CGLAB-696 task 3: the model key never enters the machine. The guest is given a
 * placeholder in the key's env var; its connections to the inference host are
 * redirected by the machine's decider to this injector, in the launcher, which
 * terminates TLS with a certificate of the machine's own CA (the guest trusts it),
 * puts the real key where the placeholder is (auth headers and a `key` query
 * parameter only), and sends the request on to the real host, by name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { realBroker, smolvmTestsEnabled } from './fixtures/smolvm-real';
import tls from 'tls';
import http from 'http';
import crypto from 'crypto';
import net from 'net';
import https from 'https';
import { machineCa, startKeyInjector, placeholderFor, upstreamTarget, leafFor, type MachineCa } from '../airlock/keyInjector';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-inject-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('machineCa', () => {
  it('makes the CA again when the certificate on disk is not its key\'s', () => {
    const a = machineCa(dir);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-inject-mix-'));
    try {
      fs.writeFileSync(path.join(dir, 'ca.pem'), machineCa(other).certPem);
      const b = machineCa(dir);
      expect(new crypto.X509Certificate(b.certPem).checkPrivateKey(crypto.createPrivateKey(b.keyPem))).toBe(true);
      expect(b.certPem).not.toBe(a.certPem);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('makes a CA once and reuses it, its key readable by the user only', () => {
    const a = machineCa(dir);
    const b = machineCa(dir);
    expect(b.certPem).toBe(a.certPem);
    const cert = new crypto.X509Certificate(a.certPem);
    expect(cert.ca).toBe(true);
    const keyFile = fs.readdirSync(dir).find((f) => f.endsWith('.key')) as string;
    expect((fs.statSync(path.join(dir, keyFile)).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('placeholderFor', () => {
  it('is random, and says nothing of the key', () => {
    const a = placeholderFor('OPENAI_API_KEY');
    expect(a).not.toBe(placeholderFor('OPENAI_API_KEY'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{24,}$/);
  });
});

describe('startKeyInjector', () => {
  let ca: MachineCa;
  let upstream: http.Server;
  let upstreamPort: number;
  let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;
  let injector: { port: number; close(): Promise<void> } | null;
  const KEY = 'sk-real-not-a-real-key-0000';
  const PH = 'airlock_ph_0123456789abcdefghij';

  beforeEach(async () => {
    ca = machineCa(dir);
    seen = [];
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 10);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;
    injector = await startKeyInjector({
      ca,
      routes: [{ host: 'api.inference.test', port: 443 }],
      secrets: [{ placeholder: PH, value: KEY }],
      // The real host, in the test: plain HTTP on the loopback.
      connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }),
    });
  });
  afterEach(async () => {
    await injector?.close();
    injector = null;
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  // Story review 3: the real upstream is TLS, reached by the inference host's name (SNI and the
  // certificate's identity), whatever address the decider allowed.
  it('reaches a TLS upstream by the inference host\'s name, checking its certificate against it', async () => {
    await injector!.close();
    const upCa = machineCa(fs.mkdtempSync(path.join(dir, 'upstream-ca-')));
    const leaf = leafFor(upCa, 'api.inference.test');
    const got: Array<{ sni: string | false; auth?: string }> = [];
    const tlsUp = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      got.push({ sni: (req.socket as tls.TLSSocket).servername, auth: req.headers.authorization });
      res.end('ok');
    });
    await new Promise<void>((r) => tlsUp.listen(0, '127.0.0.1', () => r()));
    try {
      injector = await startKeyInjector({
        ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [{ placeholder: PH, value: KEY }],
        connectUpstream: () => ({ protocol: 'https:', hostname: '127.0.0.1', port: (tlsUp.address() as net.AddressInfo).port }),
        upstreamCa: upCa.certPem,
      });
      const r = await request({ headers: { authorization: `Bearer ${PH}` } });
      expect(r.status, r.body).toBe(200);
      expect(got).toEqual([{ sni: 'api.inference.test', auth: `Bearer ${KEY}` }]);
    } finally {
      await new Promise<void>((r) => tlsUp.close(() => r()));
    }
  });

  /** A request through the injector as the guest makes it: TLS to the inference host's name, trusting the machine's CA. */
  function request(o: { servername?: string; path?: string; headers?: Record<string, string>; body?: string; trust?: string; verify?: boolean }): Promise<{ status: number; body: string; error?: string }> {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: injector!.port,
        method: o.body ? 'POST' : 'GET',
        path: o.path ?? '/v1/chat',
        headers: { host: 'api.inference.test', ...o.headers },
        createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: o.servername ?? 'api.inference.test', ca: o.trust ?? ca.certPem, rejectUnauthorized: o.verify ?? true }),
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      if (o.body) req.write(o.body);
      req.end();
    });
  }

  it('puts the real key where the placeholder is, in Authorization, and streams the answer back', async () => {
    const r = await request({ headers: { authorization: `Bearer ${PH}` } });
    expect(r.status).toBe(200);
    expect(r.body).toBe('data: one\n\ndata: two\n\n');
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('replaces it in the other key headers and a key query parameter', async () => {
    await request({ path: `/v1/models?key=${PH}&x=1`, headers: { 'x-api-key': PH, 'api-key': PH, 'x-goog-api-key': PH } });
    expect(seen[0].url).toBe(`/v1/models?key=${KEY}&x=1`);
    expect(seen[0].headers['x-api-key']).toBe(KEY);
    expect(seen[0].headers['api-key']).toBe(KEY);
    expect(seen[0].headers['x-goog-api-key']).toBe(KEY);
  });

  it('never puts the key in the body or another header, which a server might echo back', async () => {
    await request({ headers: { 'x-echo': PH, authorization: 'Bearer nothing' }, body: `{"prompt":"${PH}"}` });
    expect(seen[0].headers['x-echo']).toBe(PH);
    expect(seen[0].body).toBe(`{"prompt":"${PH}"}`);
    expect(JSON.stringify(seen[0])).not.toContain(KEY);
  });

  it('sends the request to the route\'s host whatever Host header the guest sends', async () => {
    const upstreams: Array<{ hostname: string; port: number }> = [];
    await injector!.close();
    injector = await startKeyInjector({
      ca,
      routes: [{ host: 'api.inference.test', port: 443 }],
      secrets: [{ placeholder: PH, value: KEY }],
      connectUpstream: (host, port) => { upstreams.push({ hostname: host, port }); return { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }; },
    });
    await request({ headers: { host: 'evil.example.com', authorization: `Bearer ${PH}` } });
    expect(upstreams).toEqual([{ hostname: 'api.inference.test', port: 443 }]);
    expect(seen[0].headers.host).toBe('api.inference.test');
  });

  it('presents a certificate for the inference host, issued by the machine\'s CA', async () => {
    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.inference.test', ca: ca.certPem }, () => { resolve(s.getPeerCertificate()); s.end(); });
      s.on('error', (e) => { if (!s.authorized) reject(e); });
    });
    expect(cert.subjectaltname).toContain('DNS:api.inference.test');
  });

  it('refuses a TLS name it does not inject for: no certificate for another host, even to a client that checks none', async () => {
    const r = await request({ servername: 'other.example.com', verify: false });
    expect(r.status).toBe(0);
    expect(seen).toEqual([]);
  });

  it('is not trusted without the machine\'s CA', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-inject-other-'));
    try {
      const r = await request({ headers: { authorization: `Bearer ${PH}` }, trust: machineCa(otherDir).certPem });
      expect(r.status).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  /** Raw bytes over TLS to the injector, as a guest could send them. */
  function raw(text: string): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      const s = tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.inference.test', ca: ca.certPem }, () => s.write(text));
      s.on('data', (d) => { out += d; if (out.includes('\r\n\r\n')) { s.destroy(); resolve(out); } });
      s.on('error', () => resolve(out));
      s.on('close', () => resolve(out));
    });
  }

  it('answers 400 to a request target it cannot read, and keeps serving', async () => {
    expect(await raw('GET //[ HTTP/1.1\r\nHost: api.inference.test\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
    expect((await request({ headers: { authorization: `Bearer ${PH}` } })).status).toBe(200);
  });

  it('cancels the request upstream when the guest goes away', async () => {
    let upstreamClosed = false;
    const hang = http.createServer((req) => { req.on('close', () => { upstreamClosed = true; }); });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    await injector!.close();
    injector = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [], connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: hangPort }) });
    try {
      const s = tls.connect({ host: '127.0.0.1', port: injector.port, servername: 'api.inference.test', ca: ca.certPem }, () => s.write('GET /stream HTTP/1.1\r\nHost: api.inference.test\r\n\r\n'));
      s.on('error', () => undefined);
      await new Promise((r) => setTimeout(r, 100));
      s.destroy();
      await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    } finally {
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it('cancels requests still upstream when it closes', async () => {
    let upstreamClosed = false;
    let arrived = false;
    const hang = http.createServer((req) => { arrived = true; req.on('close', () => { upstreamClosed = true; }); });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    await injector!.close();
    injector = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [], connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: hangPort }) });
    try {
      const s = tls.connect({ host: '127.0.0.1', port: injector.port, servername: 'api.inference.test', ca: ca.certPem }, () => s.write('GET /stream HTTP/1.1\r\nHost: api.inference.test\r\n\r\n'));
      s.on('error', () => undefined);
      // upstream for certain (a fixed wait lost the race under a loaded suite)
      await vi.waitFor(() => expect(arrived).toBe(true));
      await injector.close();
      injector = null;
      await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    } finally {
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it('answers 503 past 64 requests at once', async () => {
    const hang = http.createServer(() => undefined);
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    await injector!.close();
    injector = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [], connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: hangPort }) });
    const held: tls.TLSSocket[] = [];
    try {
      for (let i = 0; i < 64; i++) {
        held.push(await new Promise<tls.TLSSocket>((r) => { const s = tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.inference.test', ca: ca.certPem }, () => { s.write('GET /hold HTTP/1.1\r\nHost: api.inference.test\r\n\r\n'); r(s); }); s.on('error', () => undefined); }));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(await raw('GET /one-more HTTP/1.1\r\nHost: api.inference.test\r\n\r\n')).toMatch(/^HTTP\/1\.1 503/);
    } finally {
      for (const s of held) s.destroy();
      await injector!.close();
      injector = null;
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it('listens on a Unix socket when given one', async () => {
    const sock = path.join('/tmp', `agenfk-inj-${process.pid}-${Date.now()}.sock`);
    const viaSocket = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [{ placeholder: PH, value: KEY }], socketPath: sock, connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }) });
    try {
      expect(viaSocket.socket).toBe(sock);
      const status = await new Promise<number>((resolve) => {
        const raw = net.connect(sock, () => {
          raw.write('AGENFK-DEST 127.0.0.1\n');
          const req = http.request({ method: 'GET', path: '/v1', headers: { authorization: `Bearer ${PH}` }, createConnection: () => tls.connect({ socket: raw, servername: 'api.inference.test', ca: ca.certPem }) }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
          req.on('error', () => resolve(0));
          req.end();
        });
      });
      expect(status).toBe(200);
      expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      await viaSocket.close();
    }
  });

  // Story review 2 (ISO-2): on its socket the injector is handed a flow the decider approved for an
  // address; it connects there, never by the name again (a name re-resolving elsewhere would take the key).
  const viaSocketPreface = async (preface: string | null, hosts: string[]) => {
    const sock = path.join('/tmp', `agenfk-inj-${process.pid}-${Date.now()}-p.sock`);
    const asked: Array<string | undefined> = [];
    const inj = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [{ placeholder: PH, value: KEY }], socketPath: sock,
      connectUpstream: (_h, _p, address) => { asked.push(address); return { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }; } });
    try {
      const status = await new Promise<number>((resolve) => {
        const raw = net.connect(sock, () => {
          if (preface !== null) raw.write(preface);
          const req = http.request({ method: 'GET', path: '/v1', headers: { authorization: `Bearer ${PH}` }, createConnection: () => tls.connect({ socket: raw, servername: 'api.inference.test', ca: ca.certPem }) }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
          req.on('error', () => resolve(0));
          req.end();
        });
        raw.on('error', () => resolve(0));
      });
      hosts.push(...asked.map(String));
      return status;
    } finally {
      await inj.close();
    }
  };

  it('on its socket, sends a flow to the address the decider approved for it', async () => {
    const asked: string[] = [];
    expect(await viaSocketPreface('AGENFK-DEST 203.0.113.7\n', asked)).toBe(200);
    expect(asked).toEqual(['203.0.113.7']);
  });

  it('on its socket, refuses a flow with no approved address, or one that is not an address', async () => {
    const before = seen.length;
    for (const preface of [null, 'AGENFK-DEST api.inference.test\n', 'HELLO 203.0.113.7\n']) {
      expect(await viaSocketPreface(preface, []), String(preface)).toBe(0);
    }
    expect(seen.length).toBe(before);
  });

  it('connects upstream to the approved address, checking the certificate for the host\'s name', () => {
    expect(upstreamTarget({ host: 'api.inference.test', port: 443 }, '203.0.113.7'))
      .toEqual({ protocol: 'https:', hostname: '203.0.113.7', servername: 'api.inference.test', port: 443 });
    // Without one (its loopback port, which only tests use): the name.
    expect(upstreamTarget({ host: 'api.inference.test', port: 443 }, undefined))
      .toEqual({ protocol: 'https:', hostname: 'api.inference.test', servername: 'api.inference.test', port: 443 });
  });

  // Review: the real upstream dial, not a stand-in - to the approved address, the certificate
  // checked for the route's name.
  it('dials the approved address over TLS and checks the certificate for the host\'s name', async () => {
    const upCa = machineCa(fs.mkdtempSync(path.join(dir, 'up-')));
    const serve = (host: string) => new Promise<https.Server>((resolve) => {
      const leaf = leafFor(upCa, host);
      const s = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: '' }); res.end('ok'); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const call = async (server: https.Server) => {
      const port = (server.address() as net.AddressInfo).port;
      const sock = path.join('/tmp', `agenfk-inj-${process.pid}-${Date.now()}-t.sock`);
      // The route's name resolves nowhere: only the approved address can be reached.
      const inj = await startKeyInjector({ ca, routes: [{ host: 'api.inference.invalid', port }], secrets: [{ placeholder: PH, value: KEY }], socketPath: sock, upstreamCa: upCa.certPem });
      try {
        return await new Promise<number>((resolve) => {
          const raw = net.connect(sock, () => {
            raw.write('AGENFK-DEST 127.0.0.1\n');
            const req = http.request({ method: 'GET', path: '/v1', headers: { authorization: `Bearer ${PH}` }, createConnection: () => tls.connect({ socket: raw, servername: 'api.inference.invalid', ca: ca.certPem }) }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
            req.on('error', () => resolve(0));
            req.end();
          });
        });
      } finally {
        await inj.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    };
    const before = seen.length;
    expect(await call(await serve('api.inference.invalid'))).toBe(200);
    expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
    // A certificate for another name: refused, and no request (no key) reached it.
    const n = seen.length;
    expect(await call(await serve('other.inference.invalid'))).toBe(502);
    expect(seen.length).toBe(n);
    expect(n).toBe(before + 1);
  });

  it('on its socket, cuts a flow whose TLS handshake never completes', async () => {
    const sock = path.join('/tmp', `agenfk-inj-${process.pid}-${Date.now()}-h.sock`);
    const inj = await startKeyInjector({ ca, routes: [{ host: 'api.inference.test', port: 443 }], secrets: [{ placeholder: PH, value: KEY }], socketPath: sock, handshakeTimeoutMs: 100 });
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const raw = net.connect(sock, () => raw.write('AGENFK-DEST 127.0.0.1\n'));
        raw.on('close', () => resolve(true));
        raw.on('error', () => undefined);
        setTimeout(() => { resolve(false); raw.destroy(); }, 3000);
      });
      expect(closed).toBe(true);
    } finally {
      await inj.close();
    }
  });

  it('listens on the loopback only', async () => {
    const addr = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.inference.test', ca: ca.certPem }, () => { resolve(s.localAddress ?? ''); s.end(); });
      s.on('error', () => undefined);
    });
    expect(addr).toBe('127.0.0.1');
  });
});

// The real smolvm, the real decider process and the real injector, where they can run.
const smolvmHere = smolvmTestsEnabled();

describe.skipIf(!smolvmHere)('relay and key injection against the real smolvm (AGENFK_SMOLVM_TESTS=1, after npm run build)', () => {
  it('the guest reaches its relay through the gateway, nothing else there, and the inference host with the key it never sees', async () => {
    const { SmolvmRuntime } = await import('../airlock/smolvm');
    const { buildSandboxSpec } = await import('../airlock/spec');
    const { normalizeAirlockPolicy } = await import('@agenfk/core');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-inject-vm-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'repo');
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const REAL = 'sk-real-test-not-a-key-1234';
    // The relay to the AgEnFK server, and the inference host, both stand-ins on the host loopback.
    const relay = http.createServer((_q, r) => r.end('relay-ok'));
    const inference = http.createServer((q, r) => r.end(q.headers.authorization === `Bearer ${REAL}` ? 'key-injected' : `wrong-key:${q.headers.authorization}`));
    await Promise.all([relay, inference].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))));
    const relayPort = (relay.address() as { port: number }).port;
    const inferencePort = (inference.address() as { port: number }).port;
    const sandboxHome = process.env.HOME;
    process.env.HOME = os.userInfo().homedir;
    const stateDir = path.join(root, 'state');
    const broker = realBroker(stateDir);
    const rt = new SmolvmRuntime({
      image: 'node:22-alpine', egress: broker, stateDir, isTTY: false, hostEnv: { TEST_API_KEY: REAL },
      startInjector: (o) => startKeyInjector({ ...o, connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port: inferencePort }) }),
    });
    const spec = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'observe', hosts: { allow: [] } }), {
      client: 'pi', home, workspace, tempDirs: [], inferenceHosts: ['inference.airlock.test'], serverPort: relayPort,
      serverUrl: `http://127.0.0.1:${relayPort}`, installDirs: [], maskedEnv: ['TEST_API_KEY'],
    });
    try {
      const out = path.join(workspace, 'probe.out');
      const script = `
        const http = require('http'), https = require('https'), fs = require('fs');
        const lines = [];
        const get = (mod, opts) => new Promise((res) => mod.get(opts, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res(b)); }).on('error', (e) => res('error:' + e.code)));
        (async () => {
          lines.push('relay:' + await get(http, process.env.AGENFK_API_URL + '/health'));
          lines.push('other:' + await get(http, 'http://' + process.env.GW + ':3000/'));
          lines.push('inference:' + await get(https, { host: '203.0.113.10', servername: 'inference.airlock.test', path: '/v1/models', headers: { host: 'inference.airlock.test', authorization: 'Bearer ' + process.env.TEST_API_KEY } }));
          // What the guest sees, for the host to judge: the real key never goes into the guest, not even in this script.
          fs.writeFileSync('${out}.key', String(process.env.TEST_API_KEY));
          fs.writeFileSync('${out}', lines.join('\\n') + '\\n');
        })();`;
      const launched = await rt.launch({ ...spec, env: { ...spec.env, GW: '100.96.0.1' } }, { file: 'node', args: ['-e', script], cwd: workspace });
      expect((await launched.exited).code).toBe(0);
      expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toEqual([
        'relay:relay-ok',
        'other:error:ECONNRESET',
        'inference:key-injected',
      ]);
      const seen = fs.readFileSync(`${out}.key`, 'utf8');
      expect(seen).not.toBe(REAL);
      expect(seen).toMatch(/^airlock_[A-Za-z0-9_-]{32}$/);
      expect(script).not.toContain(REAL);
    } finally {
      await rt.reset(workspace).catch(() => undefined);
      await rt.dispose();
      process.env.HOME = sandboxHome;
      await Promise.all([relay, inference].map((s) => new Promise<void>((r) => s.close(() => r()))));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
