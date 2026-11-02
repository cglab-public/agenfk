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

  it('resolves null when nothing is listening', async () => {
    // Port 1 is privileged and unbound in every environment we run in.
    expect(await httpGet(1, '/version')).toBeNull();
  }, 10000);
});

/*
 * The two hang cases. Node's `timeout` is an inactivity timer, so a server
 * that dribbles bytes resets it forever; only the wall-clock deadline settles
 * the probe. The deadline is a parameter so this takes 150ms, not the real 2s,
 * and each test asserts BOTH ends: it gave up, and at the deadline it was given.
 */
describe('httpGet with the deadline it is given', () => {
  const DEADLINE = 150;
  const timed = async (port: number) => {
    const started = Date.now();
    const result = await httpGet(port, '/version', {}, DEADLINE);
    return { result, elapsed: Date.now() - started };
  };

  it('settles on a server that dribbles bytes forever, at that deadline', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(timer));
    });
    const { result, elapsed } = await timed(port);
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE - 20);
    expect(elapsed, 'the deadline passed in was ignored').toBeLessThan(1000);
  });

  it('settles on a server that accepts the connection and never replies, at that deadline', async () => {
    const port = await listen(() => { /* deliberately no response */ });
    const { result, elapsed } = await timed(port);
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE - 20);
    expect(elapsed, 'the deadline passed in was ignored').toBeLessThan(1000);
  });
});

describe('a response that dies half-way', () => {
  // An error after the headers must settle the probe, not hang or reject it.
  // The deadline is set far past the test's own timeout, so only the error
  // path can settle it in time.
  it('settles with null rather than hanging or rejecting', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"version":');
      res.destroy();
    });
    await expect(httpGet(port, '/version', {}, 60_000)).resolves.toBeNull();
  }, 1500);
});
