/**
 * b3a0992f (GH-356 follow-up): a Codex ChatGPT login held on the host. The guest's auth.json is a
 * stand-in (shape from spike 2144721a: a JWT-shaped id_token with a signature segment, an opaque
 * access token, any refresh token, the real account_id, last_refresh). The injector puts the real
 * Bearer in toward chatgpt.com, the WebSocket upgrade included (codex tries it first), and answers
 * codex's POST auth.openai.com/oauth/token itself: invalidate + get, then fresh stand-ins. The
 * stand-in refresh token never leaves the host; nothing else on auth.openai.com is answered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import http from 'http';
import net from 'net';
import { machineCa, startKeyInjector, type MachineCa, type LocalAnswer } from '../airlock/keyInjector';
import { codexStandInAuth, codexTokenAnswer, standInIdToken } from '../airlock/codexLogin';
import { TokenSourceError } from '../airlock/tokenSource';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-codex-login-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ACCESS = 'airlock_access_standin_0123456789';
const REFRESH = 'airlock_refresh_standin_0123456789';

describe('the stand-in auth.json', () => {
  it('has what codex needs to start on a ChatGPT login, and the account it is for', () => {
    const auth = JSON.parse(codexStandInAuth({ accessToken: ACCESS, refreshToken: REFRESH, accountId: 'acct-1', now: Date.UTC(2026, 10, 4) }));
    expect(auth).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: ACCESS, refresh_token: REFRESH, account_id: 'acct-1' },
      last_refresh: '2026-11-04T00:00:00.000Z',
    });
    expect(auth.tokens.id_token).toBe(standInIdToken());
  });

  it('its id_token is a JWT in shape (three parts, a signature segment that is not empty) carrying no claims about the person', () => {
    const parts = standInIdToken().split('.');
    expect(parts).toHaveLength(3);
    expect(parts[2].length).toBeGreaterThan(0);
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // No exp: codex refreshes by itself an id_token about to expire.
    expect(claims.exp).toBeUndefined();
    expect(JSON.stringify(claims)).not.toMatch(/@/);
  });

  it('an account id is required: chatgpt-account-id comes from it alone', () => {
    expect(() => codexStandInAuth({ accessToken: ACCESS, refreshToken: REFRESH, accountId: '' })).toThrow(/account/);
  });
});

describe('codexTokenAnswer: the host answers codex\'s refresh', () => {
  const token = (values = ['live-1', 'live-2']) => {
    let i = 0;
    return { get: vi.fn(async () => values[Math.min(i, values.length - 1)]), invalidate: vi.fn(async () => { i++; }) };
  };
  const ask = (answer: LocalAnswer, body: unknown, method = 'POST', p = '/oauth/token') =>
    answer({ method, path: p, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

  it('a refresh with the stand-in refresh token invalidates the held token, asks again, and replies with stand-ins', async () => {
    const t = token();
    const answer = codexTokenAnswer({ token: t, accessToken: ACCESS, refreshToken: REFRESH });
    const r = await ask(answer, { client_id: 'app_x', grant_type: 'refresh_token', refresh_token: REFRESH, scope: 'openid' });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ id_token: standInIdToken(), access_token: ACCESS, refresh_token: REFRESH });
    expect(t.invalidate).toHaveBeenCalledWith('live-1');
    expect(t.get).toHaveBeenCalledTimes(2);
    // The real token never goes back to the guest.
    expect(r.body).not.toContain('live-');
  });

  it('a refresh token that is not the stand-in is refused, and the source is not touched', async () => {
    const t = token();
    const r = await ask(codexTokenAnswer({ token: t, accessToken: ACCESS, refreshToken: REFRESH }), { grant_type: 'refresh_token', refresh_token: 'someone-elses' });
    expect(r.status).toBe(401);
    expect(t.invalidate).not.toHaveBeenCalled();
  });

  it('anything else on the login host is refused: no login flow runs inside the machine', async () => {
    const answer = codexTokenAnswer({ token: token(), accessToken: ACCESS, refreshToken: REFRESH });
    expect((await ask(answer, '', 'GET', '/oauth/authorize?client_id=x')).status).toBe(403);
    expect((await ask(answer, { refresh_token: REFRESH }, 'POST', '/api/accounts/deviceauth/usercode')).status).toBe(403);
    expect((await ask(answer, 'not json')).status).toBe(400);
  });

  it('a source error\'s own message never reaches the guest: it may carry the stale token (review)', async () => {
    const answer = codexTokenAnswer({
      token: { get: async () => 'live-1', invalidate: async (stale) => { throw new TokenSourceError('revoked', undefined, `could not drop ${stale}`); } },
      accessToken: ACCESS, refreshToken: REFRESH,
    });
    const r = await ask(answer, { grant_type: 'refresh_token', refresh_token: REFRESH });
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/revoked/);
    expect(r.body).not.toContain('live-1');
  });

  it('a source that cannot give a login answers 502 with what is wrong (never a 401: codex would say to log in again inside)', async () => {
    const answer = codexTokenAnswer({ token: { get: async () => { throw new TokenSourceError('revoked'); }, invalidate: async () => undefined }, accessToken: ACCESS, refreshToken: REFRESH });
    const r = await ask(answer, { grant_type: 'refresh_token', refresh_token: REFRESH });
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/revoked/);
  });
});

describe('startKeyInjector: a route the host answers itself', () => {
  let ca: MachineCa;
  let injector: { port: number; close(): Promise<void> } | null = null;
  let upstreamHits = 0;
  let upstream: http.Server;
  beforeEach(async () => {
    ca = machineCa(dir);
    upstreamHits = 0;
    upstream = http.createServer((_req, res) => { upstreamHits++; res.end('upstream'); });
    upstream.on('upgrade', (_req, s: net.Socket) => { upstreamHits++; s.destroy(); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  });
  afterEach(async () => {
    await injector?.close();
    injector = null;
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const call = (host: string, method: string, p: string, body = '', headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; type?: string }>((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: injector!.port, method, path: p, headers: { host, ...headers },
      createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: host, ca: ca.certPem }),
    }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, type: res.headers['content-type'] })); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });

  it('answers on the host, with what the answer gives, and sends nothing upstream', async () => {
    const answer = vi.fn<LocalAnswer>(async (r) => ({ status: 200, body: JSON.stringify({ got: r.body.toString(), method: r.method, path: r.path }) }));
    const port = (upstream.address() as net.AddressInfo).port;
    injector = await startKeyInjector({
      ca, routes: [{ host: 'auth.openai.test', port: 443, answer }], secrets: [],
      connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port }),
    });
    const r = await call('auth.openai.test', 'POST', '/oauth/token', '{"a":1}');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/json/);
    expect(JSON.parse(r.body)).toEqual({ got: '{"a":1}', method: 'POST', path: '/oauth/token' });
    expect(upstreamHits).toBe(0);
  });

  it('caps what it reads for an answer: a body past 64 KiB is 413', async () => {
    const answer = vi.fn<LocalAnswer>(async () => ({ status: 200, body: '{}' }));
    injector = await startKeyInjector({ ca, routes: [{ host: 'auth.openai.test', port: 443, answer }], secrets: [] });
    expect((await call('auth.openai.test', 'POST', '/oauth/token', 'x'.repeat(65 * 1024))).status).toBe(413);
    expect(answer).not.toHaveBeenCalled();
  });

  it('a guest that leaves while its refresh is answered keeps its slot until the answer settles (review): the 65th is 503', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((res) => { unblock = res; });
    const answer = vi.fn<LocalAnswer>(async () => { await blocked; return { status: 200, body: '{}' }; });
    injector = await startKeyInjector({ ca, routes: [{ host: 'auth.openai.test', port: 443, answer }], secrets: [] });
    const reqs: http.ClientRequest[] = [];
    for (let k = 0; k < 64; k++) {
      const req = http.request({
        host: '127.0.0.1', port: injector.port, method: 'POST', path: '/oauth/token', headers: { host: 'auth.openai.test' },
        createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'auth.openai.test', ca: ca.certPem }),
      });
      req.on('error', () => undefined);
      req.end('{}');
      reqs.push(req);
    }
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(64), { timeout: 5000 });
    for (const q of reqs) q.destroy();
    await new Promise((res) => setTimeout(res, 300));
    try {
      expect((await call('auth.openai.test', 'POST', '/oauth/token', '{}')).status).toBe(503);
    } finally {
      unblock();
    }
    await new Promise((res) => setTimeout(res, 200));
    expect((await call('auth.openai.test', 'POST', '/oauth/token', '{}')).status).toBe(200);
  });

  it('refuses a WebSocket upgrade on an answered route', async () => {
    const answer = vi.fn<LocalAnswer>(async () => ({ status: 200, body: '{}' }));
    const port = (upstream.address() as net.AddressInfo).port;
    injector = await startKeyInjector({
      ca, routes: [{ host: 'auth.openai.test', port: 443, answer }], secrets: [],
      connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port }),
    });
    const r = await call('auth.openai.test', 'GET', '/ws', '', { connection: 'Upgrade', upgrade: 'websocket' });
    expect(r.status).toBe(403);
    expect(upstreamHits).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('startKeyInjector: WebSocket upgrades (codex tries one before HTTPS)', () => {
  let ca: MachineCa;
  let upstream: http.Server;
  let port: number;
  let injector: { port: number; close(): Promise<void> } | null = null;
  let handshakes: Array<{ auth?: string; host?: string; upgrade?: string; path?: string }>;
  /** What the upstream answers each handshake: 101, or a status it refuses with. */
  let answers: number[];
  const PH = 'airlock_ph_wswswswswswswswswsws';
  /** The upstream's switched sockets: its server no longer tracks them, and keeps them half open. */
  let switched: Set<net.Socket>;

  beforeEach(async () => {
    ca = machineCa(dir);
    handshakes = [];
    answers = [101];
    switched = new Set();
    upstream = http.createServer((_req, res) => res.end('plain'));
    upstream.on('upgrade', (req, s: net.Socket, head: Buffer) => {
      switched.add(s);
      s.on('end', () => s.end());
      handshakes.push({ auth: req.headers.authorization, host: req.headers.host, upgrade: req.headers.upgrade, path: req.url });
      const status = answers.shift() ?? 101;
      if (status !== 101) {
        s.end(`HTTP/1.1 ${status} Refused\r\ncontent-length: 7\r\nconnection: close\r\n\r\nrefused`);
        return;
      }
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (head.length) s.write(`echo:${head}`);
      s.on('data', (d) => s.write(`echo:${d}`));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    port = (upstream.address() as net.AddressInfo).port;
  });
  afterEach(async () => {
    await injector?.close();
    injector = null;
    for (const s of switched) s.destroy();
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const start = async (secrets: Parameters<typeof startKeyInjector>[0]['secrets']) => {
    injector = await startKeyInjector({
      ca, routes: [{ host: 'chatgpt.test', port: 443 }], secrets,
      connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port }),
    });
  };
  /** Opens a WebSocket-style upgrade through the injector; resolves with the status and, on 101, a send/receive. */
  const upgrade = (auth: string) => new Promise<{ status: number; body?: string; exchange?: (s: string) => Promise<string>; socket?: net.Socket }>((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: injector!.port, method: 'GET', path: '/backend-api/codex/responses',
      headers: { host: 'evil.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', authorization: auth },
      createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'chatgpt.test', ca: ca.certPem }),
    });
    req.on('upgrade', (res, socket) => {
      resolve({
        status: res.statusCode ?? 0, socket,
        exchange: (s) => new Promise((r) => { socket.once('data', (d) => r(d.toString())); socket.write(s); }),
      });
    });
    req.on('response', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });

  it('puts the token where the stand-in is on the handshake, by the route\'s host, and carries the frames both ways', async () => {
    await start([{ placeholder: PH, token: { get: async () => 'live-1', invalidate: async () => undefined } }]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    expect(handshakes).toEqual([{ auth: 'Bearer live-1', host: 'chatgpt.test', upgrade: 'websocket', path: '/backend-api/codex/responses' }]);
    expect(await r.exchange!('hello')).toBe('echo:hello');
    // Frames are never swapped: a stand-in in one goes as it is.
    expect(await r.exchange!(`Bearer ${PH}`)).toBe(`echo:Bearer ${PH}`);
    r.socket!.destroy();
  });

  it('a key the host holds is swapped on the handshake too', async () => {
    await start([{ placeholder: PH, value: 'sk-real' }]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    expect(handshakes[0].auth).toBe('Bearer sk-real');
    r.socket!.destroy();
  });

  it('a handshake refused 401 invalidates the token, asks once more and tries again', async () => {
    const values = ['live-1', 'live-2'];
    let i = 0;
    const token = { get: vi.fn(async () => values[i]), invalidate: vi.fn(async () => { i = 1; }) };
    await start([{ placeholder: PH, token }]);
    answers = [401, 101];
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    expect(token.invalidate).toHaveBeenCalledWith('live-1');
    expect(handshakes.map((h) => h.auth)).toEqual(['Bearer live-1', 'Bearer live-2']);
    r.socket!.destroy();
  });

  it('a second 401 is the answer the guest gets: no loop, and its body reaches the guest', async () => {
    await start([{ placeholder: PH, token: { get: async () => 'live-1', invalidate: async () => undefined } }]);
    answers = [401, 401, 101];
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(401);
    expect(r.body).toBe('refused');
    expect(handshakes).toHaveLength(2);
  });

  it('a source that cannot give the login answers the handshake 502, and nothing goes upstream', async () => {
    await start([{ placeholder: PH, token: { get: async () => { throw new TokenSourceError('not_connected'); }, invalidate: async () => undefined } }]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(502);
    expect(handshakes).toEqual([]);
  });

  it('a source error\'s message never reaches the guest on a handshake either (review)', async () => {
    await start([{ placeholder: PH, token: { get: async () => { throw new TokenSourceError('not_connected', undefined, 'token live-secret-1 is stale'); }, invalidate: async () => undefined } }]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/not_connected/);
    expect(r.body).not.toContain('live-secret-1');
  });

  it('a token Node refuses in a header (CR/LF) is a 502 for the guest, not a launcher crash (review)', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      await start([{ placeholder: PH, token: { get: async () => 'live\r\nx-evil: 1', invalidate: async () => undefined } }]);
      const r = await upgrade(`Bearer ${PH}`);
      expect(r.status).toBe(502);
      expect(handshakes).toEqual([]);
      await new Promise((res) => setTimeout(res, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('the refused handshake is cut before the retry: a 401 body that never ends does not run on (review)', async () => {
    let firstClosed!: Promise<void>;
    let n = 0;
    upstream.removeAllListeners('upgrade');
    upstream.on('upgrade', (req, s: net.Socket) => {
      switched.add(s);
      handshakes.push({ auth: req.headers.authorization });
      if (n++ === 0) {
        // Its end from the injector's side is the cut (a switched server socket stays half open).
        firstClosed = new Promise((res) => s.once('end', () => res()));
        // A 401 whose chunked body never ends.
        s.write('HTTP/1.1 401 Unauthorized\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n');
        return;
      }
      s.on('end', () => s.end());
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    const values = ['live-1', 'live-2'];
    let i = 0;
    await start([{ placeholder: PH, token: { get: async () => values[i], invalidate: async () => { i = 1; } } }]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    await firstClosed;
    r.socket!.destroy();
  });

  it('a guest that leaves while its token is asked for keeps its slot until the ask ends (review): the 65th is 503', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((res) => { unblock = res; });
    await start([{ placeholder: PH, token: { get: async () => { await blocked; return 'live-1'; }, invalidate: async () => undefined } }]);
    const reqs: http.ClientRequest[] = [];
    for (let k = 0; k < 64; k++) {
      const req = http.request({
        host: '127.0.0.1', port: injector!.port, method: 'GET', path: '/ws',
        headers: { connection: 'Upgrade', upgrade: 'websocket', authorization: `Bearer ${PH}` },
        createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'chatgpt.test', ca: ca.certPem }),
      });
      req.on('error', () => undefined);
      req.end();
      reqs.push(req);
    }
    await new Promise((res) => setTimeout(res, 1500));
    for (const q of reqs) q.destroy();
    await new Promise((res) => setTimeout(res, 300));
    try {
      expect((await upgrade(`Bearer ${PH}`)).status).toBe(503);
    } finally {
      unblock();
    }
    await new Promise((res) => setTimeout(res, 200));
    // The asks over, the slots are back, and nothing went upstream for the guests that left.
    expect(handshakes).toEqual([]);
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    r.socket!.destroy();
  });

  it('a guest that leaves while a refused handshake\'s token is dropped keeps its slot, and gets no retry (review)', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((res) => { unblock = res; });
    const invalidate = vi.fn(async () => { await blocked; });
    const get = vi.fn(async () => 'live-1');
    await start([{ placeholder: PH, token: { get, invalidate } }]);
    answers = Array.from({ length: 64 }, () => 401);
    const reqs: http.ClientRequest[] = [];
    for (let k = 0; k < 64; k++) {
      const req = http.request({
        host: '127.0.0.1', port: injector!.port, method: 'GET', path: '/ws',
        headers: { connection: 'Upgrade', upgrade: 'websocket', authorization: `Bearer ${PH}` },
        createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'chatgpt.test', ca: ca.certPem }),
      });
      req.on('error', () => undefined);
      req.end();
      reqs.push(req);
    }
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(64), { timeout: 5000 });
    for (const q of reqs) q.destroy();
    await new Promise((res) => setTimeout(res, 300));
    try {
      expect((await upgrade(`Bearer ${PH}`)).status).toBe(503);
    } finally {
      unblock();
    }
    await new Promise((res) => setTimeout(res, 200));
    // Gone before the retry: no token asked for again, no second handshake for any of them.
    expect(get).toHaveBeenCalledTimes(64);
    expect(handshakes).toHaveLength(64);
    answers = [101];
    const r = await upgrade(`Bearer ${PH}`);
    expect(r.status).toBe(101);
    r.socket!.destroy();
  });

  it('closing the injector cuts an open WebSocket, both ends', async () => {
    let upstreamSide!: Promise<void>;
    upstream.prependListener('upgrade', (_req, s: net.Socket) => { upstreamSide = new Promise((res) => s.once('close', () => res())); });
    await start([{ placeholder: PH, token: { get: async () => 'live-1', invalidate: async () => undefined } }]);
    const r = await upgrade(`Bearer ${PH}`);
    const guestSide = new Promise<void>((res) => r.socket!.once('close', () => res()));
    await injector!.close();
    injector = null;
    await Promise.all([guestSide, upstreamSide]);
  });

  it('the guest closing its WebSocket closes the upstream one', async () => {
    let upstreamSide!: Promise<void>;
    upstream.prependListener('upgrade', (_req, s: net.Socket) => { upstreamSide = new Promise((res) => s.once('close', () => res())); });
    await start([{ placeholder: PH, token: { get: async () => 'live-1', invalidate: async () => undefined } }]);
    const r = await upgrade(`Bearer ${PH}`);
    r.socket!.destroy();
    await upstreamSide;
  });
});
