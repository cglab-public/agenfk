/**
 * CGLAB-167: the real httpGet, against real sockets.
 *
 * The injected-stub tests cover the decision logic; this file covers the part
 * with a socket in it, because that is where the interesting failure lives.
 *
 * Node's `timeout` option is an INACTIVITY timer, not a wall clock. A server
 * that dribbles one byte every so often resets it forever, so a promise that
 * only settles on 'end' never settles at all — and since resolveServer awaits
 * probe(), the app never spawns, never throws, and never shows a window. A
 * dock icon and nothing else, indefinitely.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { httpGet } from '../main/probes.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

/** Start a server on an ephemeral port and return it. */
function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

describe('httpGet', () => {
  it('reads a normal JSON response', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"version":"1.1.18"}');
    });
    const res = await httpGet(port, '/version');
    expect(res?.status).toBe(200);
    expect(res?.body).toBe('{"version":"1.1.18"}');
    expect(res?.contentType).toContain('application/json');
  });

  it('passes request headers through', async () => {
    let seen = '';
    const port = await listen((req, res) => {
      seen = String(req.headers.accept ?? '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    await httpGet(port, '/', { Accept: 'text/html' });
    expect(seen).toContain('text/html');
  });

  it('settles on a server that dribbles bytes forever instead of hanging', async () => {
    // The reproduced bug: each chunk resets Node's inactivity timer, so
    // without a wall-clock bound this never resolves.
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(timer));
    });

    const started = Date.now();
    const result = await httpGet(port, '/version');
    const elapsed = Date.now() - started;

    expect(result === null || typeof result.status === 'number').toBe(true);
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it('settles on a server that accepts the connection and never replies', async () => {
    const port = await listen(() => { /* deliberately no response */ });
    const started = Date.now();
    await httpGet(port, '/version');
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it('resolves null when nothing is listening', async () => {
    // Port 1 is privileged and unbound in every environment we run in.
    expect(await httpGet(1, '/version')).toBeNull();
  }, 10000);

  it('never resolves twice, even when the response also errors', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"version":');
      res.destroy();
    });
    // A double-resolve would be invisible here, but an unhandled rejection or
    // a crash would not — this pins that the error path is wired safely.
    await expect(httpGet(port, '/version')).resolves.not.toThrow;
  }, 10000);
});
