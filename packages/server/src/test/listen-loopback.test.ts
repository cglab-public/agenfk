/**
 * supertest reaches ITS OWN server, never a foreign one on the same port
 * (the wandering load-only flake).
 *
 * supertest calls `server.listen(0)` - the dual-stack wildcard `::` - and then
 * dialled the hard-coded http://127.0.0.1:<port>. macOS hands a wildcard bind
 * a port that another socket already holds on 127.0.0.1 SPECIFICALLY, and the
 * IPv4 connection then reaches that more specific listener: a bare ECONNRESET
 * (OrbStack permanently holds one such port on the dev machine) or some other
 * test app's 404/400/401. One request in several thousand, in whichever file
 * drew the port - which is why the failures wandered from run to run.
 *
 * vitest.setup.ts makes supertest dial the loopback of the family the server
 * actually bound: [::1] for a `::` bind, where an IPv4-only listener cannot be.
 * (Linux refuses the colliding wildcard bind outright, so it never had this.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import * as http from 'http';
import express from 'express';
import request from 'supertest';
// @ts-expect-error — plain .mjs helper
import { loopbackUrl } from '../../../../scripts/vitest-supertest-loopback.mjs';

const opened: net.Server[] = [];
const track = <T extends net.Server>(s: T): T => { opened.push(s); return s; };
const listening = (s: net.Server) => new Promise<void>((ok, fail) => { s.once('listening', ok); s.once('error', fail); });
afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise<void>(r => (s.listening ? s.close(() => r()) : r()));
});

describe('supertest dials the server it bound', () => {
  it('reaches its own app while a foreign listener holds the same port on 127.0.0.1', async (ctx) => {
    const foreign = track(http.createServer((_q, r) => { r.statusCode = 404; r.end('foreign'); }));
    foreign.listen(0, '127.0.0.1');
    await listening(foreign);
    const port = (foreign.address() as net.AddressInfo).port;

    // The collision supertest's listen(0) can land on by chance, made certain.
    const mine = track(http.createServer((_q, r) => r.end('mine')));
    mine.listen(port);
    const bound = await listening(mine).then(() => true, (e) => { expect(e.code).toBe('EADDRINUSE'); return false; });
    // This platform refuses the colliding bind, so the hijack cannot happen
    // here - say so in the report rather than pass having tested nothing.
    if (!bound) ctx.skip();

    const r = await request(mine).get('/');
    expect(r.text).toBe('mine');
  });

  it('still reaches a server bound to 127.0.0.1 explicitly', async () => {
    const s = track(http.createServer((_q, r) => r.end('v4')));
    s.listen(0, '127.0.0.1');
    await listening(s);
    expect((await request(s).get('/')).text).toBe('v4');
  });

  it('still reaches a server bound to ::1 explicitly', async () => {
    const s = track(http.createServer((_q, r) => r.end('v6')));
    s.listen(0, '::1');
    await listening(s);
    expect((await request(s).get('/')).text).toBe('v6');
  });

  it('still serves an express app handed straight to supertest', async () => {
    const app = express().get('/x', (_q, r) => r.json({ ok: true }));
    const r = await request(app).get('/x');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

describe('which loopback a server is dialled at', () => {
  const U = 'http://127.0.0.1:4321/p';
  it('dials [::1] for a wildcard bind on macOS, where the hijack happens', () => {
    expect(loopbackUrl(U, { address: '::', family: 'IPv6', port: 4321 }, 'darwin')).toBe('http://[::1]:4321/p');
  });
  it('leaves a wildcard bind alone elsewhere: ::1 may not exist (loopback IPv6 disabled in a container)', () => {
    expect(loopbackUrl(U, { address: '::', family: 'IPv6', port: 4321 }, 'linux')).toBe(U);
  });
  it('always dials [::1] for a server bound to ::1 explicitly', () => {
    expect(loopbackUrl(U, { address: '::1', family: 'IPv6', port: 4321 }, 'linux')).toBe('http://[::1]:4321/p');
  });
  it('leaves an IPv4 bind alone', () => {
    expect(loopbackUrl(U, { address: '127.0.0.1', family: 'IPv4', port: 4321 }, 'darwin')).toBe(U);
    expect(loopbackUrl(U, { address: '0.0.0.0', family: 'IPv4', port: 4321 }, 'darwin')).toBe(U);
  });
});
