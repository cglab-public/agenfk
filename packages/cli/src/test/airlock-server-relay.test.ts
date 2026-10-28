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
