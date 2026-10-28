/**
 * SX-1 (8dd7c7c0): the launcher's relay to the AgEnFK server. The sandbox is
 * given the relay's loopback port, never the server's, so everything a sandbox
 * sends the server - plain through the proxy, through a CONNECT tunnel or SOCKS
 * (measured: those skip ASRT's request filter) - reaches it through here. Each
 * request leaves marked, after any spelling of the marker header the agent sent
 * is removed; the response comes back as the server gave it.
 *
 * In enforce mode a request that cannot be marked is refused here and never
 * reaches the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { AIRLOCK_SESSION_HEADER } from '@agenfk/core';
import { startServerRelay, type ServerRelay } from '../airlock/serverRelay';

const MARK = 'v1.n0nce.' + 'a'.repeat(64);
let target: http.Server;
let targetUrl: string;
let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;
let relay: ServerRelay | null;

beforeEach(async () => {
  seen = [];
  relay = null;
  target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json', 'x-from': 'server' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetUrl = `http://127.0.0.1:${(target.address() as any).port}`;
});

afterEach(async () => {
  await relay?.close();
  await new Promise((r) => target.close(r));
});

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/items', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on('error', reject);
      res.on('close', () => { if (!res.complete) reject(new Error('response broken off')); });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('startServerRelay', () => {
  it('forwards a request to the server with the marker, replacing the one the agent sent', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    const res = await send(relay.port, { headers: { [AIRLOCK_SESSION_HEADER]: 'forged', 'x-other': 'kept' } });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers[AIRLOCK_SESSION_HEADER]).toBe(MARK);
    expect(seen[0].headers['x-other']).toBe('kept');
  });

  it('keeps the method, path, query and body, and hands back the status, headers and body', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    const res = await send(relay.port, { method: 'PUT', path: '/items/t1?x=1', headers: { 'content-type': 'application/json' }, body: '{"title":"t"}' });
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/items/t1?x=1', body: '{"title":"t"}' });
    expect(res.headers['x-from']).toBe('server');
    expect(JSON.parse(res.body)).toEqual({ ok: true, url: '/items/t1?x=1' });
    const missing = await send(relay.port, { path: '/missing' });
    expect(missing.status).toBe(404);
  });

  it('enforce: a request that cannot be marked is refused and never reaches the server', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => null, requireMarker: true });
    const res = await send(relay.port);
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/report-token.*agenfk restart/s);
    expect(seen).toHaveLength(0);
  });

  it('a marker read that throws is a refusal in enforce mode, never a pass', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => { throw new Error('boom'); }, requireMarker: true });
    expect((await send(relay.port)).status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('observe: an unmarkable request goes through unmarked, the agent\'s header removed', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => null, requireMarker: false });
    await send(relay.port, { headers: { [AIRLOCK_SESSION_HEADER]: 'forged' } });
    expect(seen[0].headers[AIRLOCK_SESSION_HEADER]).toBeUndefined();
  });

  it('the server unreachable: the agent gets a 502 saying so', async () => {
    relay = await startServerRelay({ target: 'http://127.0.0.1:9', marker: () => MARK, requireMarker: true });
    const res = await send(relay.port);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/AgEnFK server/);
  });

  it('listens on loopback only, on a port of its own, and stops on close', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    expect(relay.host).toBe('127.0.0.1');
    expect(relay.port).toBeGreaterThan(0);
    expect(relay.port).not.toBe(Number(new URL(targetUrl).port));
    const port = relay.port;
    await relay.close();
    relay = null;
    await expect(send(port)).rejects.toThrow();
  });
});

describe('startServerRelay: review (Codex gpt-6.1-sol 01a18235)', () => {
  it('a marker the server refuses as invalid is minted again once and the request sent again, body and all', async () => {
    await new Promise((r) => target.close(r));
    seen = [];
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.headers[AIRLOCK_SESSION_HEADER] === 'stale') { res.writeHead(401, { 'x-agenfk-airlock-marker': 'invalid' }); res.end('{}'); return; }
        res.writeHead(200); res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    targetUrl = `http://127.0.0.1:${(target.address() as any).port}`;
    const markers = ['stale', MARK];
    relay = await startServerRelay({ target: targetUrl, marker: () => markers.shift() ?? MARK, requireMarker: true });
    const res = await send(relay.port, { method: 'POST', path: '/items', body: '{"title":"t"}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(seen.map((x) => [x.headers[AIRLOCK_SESSION_HEADER], x.body])).toEqual([['stale', '{"title":"t"}'], [MARK, '{"title":"t"}']]);
  });

  it('it is sent again only once: a second refusal reaches the agent', async () => {
    await new Promise((r) => target.close(r));
    let hits = 0;
    target = http.createServer((req, res) => { hits++; req.resume(); res.writeHead(401, { 'x-agenfk-airlock-marker': 'invalid' }); res.end('{}'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    relay = await startServerRelay({ target: `http://127.0.0.1:${(target.address() as any).port}`, marker: () => MARK, requireMarker: true });
    expect((await send(relay.port)).status).toBe(401);
    expect(hits).toBe(2);
  });

  it('a response that breaks off mid-way does not take the relay down', async () => {
    await new Promise((r) => target.close(r));
    target = http.createServer((req, res) => {
      req.resume();
      if (req.url === '/break') { res.writeHead(200, { 'content-length': '100' }); res.write('partial'); setTimeout(() => res.socket?.destroy(), 20); return; }
      res.end('fine');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    relay = await startServerRelay({ target: `http://127.0.0.1:${(target.address() as any).port}`, marker: () => MARK, requireMarker: true });
    await send(relay.port, { path: '/break' }).catch(() => undefined);
    expect((await send(relay.port, { path: '/ok' })).body).toBe('fine');
  });

  it('close ends requests still waiting on the server, and the server sees them go', async () => {
    await new Promise((r) => target.close(r));
    let gone = false;
    target = http.createServer((req) => { req.resume(); req.socket.on('close', () => { gone = true; }); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    relay = await startServerRelay({ target: `http://127.0.0.1:${(target.address() as any).port}`, marker: () => MARK, requireMarker: true });
    const pending = send(relay.port).catch(() => 'ended');
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await relay.close();
    relay = null;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await pending).toBe('ended');
    await vi.waitFor(() => expect(gone).toBe(true));
    (target as any).closeAllConnections?.();
  });

  it('only http and https servers can be relayed to', async () => {
    await expect(startServerRelay({ target: 'ftp://127.0.0.1:21', marker: () => MARK, requireMarker: true })).rejects.toThrow(/http/);
    relay = await startServerRelay({ target: 'https://127.0.0.1:9', marker: () => MARK, requireMarker: true });
    expect((await send(relay.port)).status).toBe(502);
  });
});

describe('startServerRelay: review pass 2', () => {
  it('a refused first answer that breaks off cannot take the relay down; the second answer reaches the agent', async () => {
    await new Promise((r) => target.close(r));
    let n = 0;
    target = http.createServer((req, res) => {
      req.resume();
      if (n++ === 0) {
        res.writeHead(401, { 'x-agenfk-airlock-marker': 'invalid', 'content-length': '100' });
        res.write('{');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.end('second');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    relay = await startServerRelay({ target: `http://127.0.0.1:${(target.address() as any).port}`, marker: () => MARK, requireMarker: true });
    const res = await send(relay.port);
    expect(res.body).toBe('second');
    await new Promise((r) => setTimeout(r, 100));
    expect((await send(relay.port)).status).toBe(200);
  });
});

/**
 * SX-4 (4d1594b9): the board-only writes. Every board-only (or board-privileged)
 * route trusts `x-agenfk-ui: 1`; the board never comes through the relay and no
 * agenfk client inside the sandbox sends it, so the relay refuses any request
 * carrying it, and the board-only routes by method and path whatever the headers.
 */
describe('startServerRelay: board-only writes refused (SX-4)', () => {
  it('a request carrying the board header is refused, whatever its casing, and never reaches the server', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    for (const name of ['x-agenfk-ui', 'X-Agenfk-UI', 'X-AGENFK-UI']) {
      const res = await send(relay.port, { method: 'PUT', path: '/items/t1', headers: { [name]: '1' }, body: '{}' });
      expect(res.status, name).toBe(403);
      expect(res.body).toMatch(/board/);
    }
    // even with a value the server would not honour
    expect((await send(relay.port, { headers: { 'x-agenfk-ui': '0' } })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  // DS-3 review (Codex gpt-6.1-sol 01a18355): an observe-mode launch with no report token
  // forwards unmarked, so the server cannot tell the import came from a sandbox: refused here.
  it('a dataset import is refused at the relay, marked or not', async () => {
    for (const marker of [() => MARK, () => null]) {
      relay = await startServerRelay({ target: targetUrl, marker, requireMarker: false });
      for (const p of ['/airlock/dataset/import', '/AIRLOCK/dataset/import/', '/airlock//dataset/import?x=1']) {
        expect((await send(relay.port, { method: 'POST', path: p, body: '{}' })).status, p).toBe(403);
      }
      await relay.close();
    }
    expect(seen).toHaveLength(0);
  });

  it('the board-only routes are refused by method and path, without the header too', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    const refused: Array<[string, string]> = [
      ['PUT', '/airlock/policy'], ['PUT', '/AIRLOCK/policy/'], ['POST', '/airlock/approvals/airlock-v1:x:y/grant'],
      ['POST', '/airlock/approvals/k/deny'], ['POST', '/airlock/learning/accept'], ['POST', '/airlock/learning/forward'],
      ['POST', '/items/t1/approvals'], ['POST', '/items/t1/overrides'], ['POST', '/projects/p1/command-approvals'],
      ['POST', '/webauthn/challenge'], ['DELETE', '/webauthn/credentials/c1'], ['PUT', '/api/telemetry/config'], ['POST', '/github/signout'],
      ['PUT', '/airlock/policy?x=1'],
      // review (Codex gpt-6.1-sol 01a1827a)
      ['POST', '/releases/update'],
      ['POST', '/items/a%2Fb/approvals'],
      ['PUT', '/airlock//policy'],
    ];
    for (const [method, p] of refused) {
      expect((await send(relay.port, { method, path: p, body: method === 'POST' || method === 'PUT' ? '{}' : undefined })).status, `${method} ${p}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it('everything else the agent does still goes through', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    const allowed: Array<[string, string]> = [
      ['GET', '/airlock/policy'], ['POST', '/airlock/evaluate'], ['POST', '/items/t1/validate'], ['PUT', '/items/t1'],
      ['GET', '/items/t1/approvals'], ['POST', '/items'], ['POST', '/items/t1/comments'], ['GET', '/airlock/approvals'],
    ];
    for (const [method, p] of allowed) {
      expect((await send(relay.port, { method, path: p, body: method === 'GET' ? undefined : '{}' })).status, `${method} ${p}`).toBe(200);
    }
    expect(seen).toHaveLength(allowed.length);
  });
});

describe('startServerRelay: host terminals refused (BUG 794bb674, epic review)', () => {
  it('herdr and terminal-session routes never reach the server, marked or not, reads too', async () => {
    for (const marker of [() => MARK, () => null]) {
      relay = await startServerRelay({ target: targetUrl, marker, requireMarker: false });
      const refused: Array<[string, string]> = [
        ['GET', '/herdr/sessions'], ['GET', '/herdr/panes/p1/content'], ['POST', '/herdr/panes/p1/text'],
        ['POST', '/herdr/panes/p1/keys'], ['POST', '/herdr/panes/p1/focus'], ['POST', '/HERDR/panes/p1/keys/'],
        ['POST', '/herdr//panes/p1/text'], ['POST', '/herdr/panes/p%2F1/text'], ['GET', '/herdr'],
        ['GET', '/terminal-sessions'], ['POST', '/terminal-sessions'], ['DELETE', '/terminal-sessions/t1'], ['POST', '/Terminal-Sessions/'],
      ];
      for (const [method, p] of refused) {
        expect((await send(relay.port, { method, path: p, body: method === 'POST' ? '{}' : undefined })).status, `${method} ${p}`).toBe(403);
      }
      await relay.close();
    }
    expect(seen).toHaveLength(0);
  });

  it('a path that only starts with the same letters still goes through', async () => {
    const { boardOnlyRefusal } = await import('../airlock/serverRelay');
    expect(boardOnlyRefusal('GET', '/herdrx', {})).toBeNull();
    expect(boardOnlyRefusal('GET', '/terminal-sessionsx', {})).toBeNull();
  });
});

describe('startServerRelay: request targets (SX-4 review)', () => {
  /** One raw request line, as a client could write it. */
  function raw(port: number, requestLine: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`${requestLine}\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
      let out = '';
      sock.on('data', (d: Buffer) => { out += d.toString(); });
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
  }

  it('only an origin-form target is relayed: an absolute-form or asterisk target is refused', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    for (const line of ['PUT http://localhost/airlock/policy HTTP/1.1', 'PUT http://127.0.0.1:3000/airlock/policy HTTP/1.1', 'GET https://x/items HTTP/1.1', 'OPTIONS * HTTP/1.1']) {
      expect((await raw(relay.port, line)).split('\r\n')[0], line).toMatch(/ 40[03] /);
    }
    expect(seen).toHaveLength(0);
  });

  it('boardOnlyRefusal judges the encoded path as Express routes it, and the decoded one too', async () => {
    const { boardOnlyRefusal } = await import('../airlock/serverRelay');
    expect(boardOnlyRefusal('POST', '/items/a%2Fb/approvals', {})).toBeTruthy();
    expect(boardOnlyRefusal('PUT', '/airlock/%70olicy', {})).toBeTruthy();
    expect(boardOnlyRefusal('POST', '/items/t1/comments', {})).toBeNull();
  });
});

describe('startServerRelay: request targets (SX-4 review pass 2)', () => {
  function rawBytes(port: number, line: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(Buffer.concat([line, Buffer.from('\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')]));
      });
      let out = '';
      sock.on('data', (d: Buffer) => { out += d.toString('latin1'); });
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
  }

  it('a target with a byte outside printable ASCII is refused, never forwarded (a trailing NBSP is trimmed by the parser Express uses)', async () => {
    relay = await startServerRelay({ target: targetUrl, marker: () => MARK, requireMarker: true });
    for (const tail of [[0xa0], [0x09], [0xc2, 0xa0], [0x7f]]) {
      const line = Buffer.concat([Buffer.from('PUT /airlock/policy'), Buffer.from(tail), Buffer.from(' HTTP/1.1')]);
      const out = await rawBytes(relay.port, line).catch((e) => `ERR ${e.message}`);
      expect(out.split('\r\n')[0], JSON.stringify(tail)).toMatch(/ 40[03] |ERR|^$/);
    }
    expect(seen).toHaveLength(0);
  });

  it('boardOnlyRefusal also reads the path as the legacy URL parser does', async () => {
    const { boardOnlyRefusal } = await import('../airlock/serverRelay');
    expect(boardOnlyRefusal('PUT', '/airlock/policy ', {})).toBeTruthy();
  });
});
