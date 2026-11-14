/**
 * GH-356, host-held logins: the guest gets a stand-in, and the launcher's injector puts the real
 * token there on the way to the inference host. The token comes from a TokenSource (interface agreed
 * with the factory, SPEC-043 PRX-5/6): pulled when needed, cached until 60 s before it expires; on an
 * upstream 401 the injector invalidates it and asks once more. Airlock never refreshes a login: the
 * source does (the local one reads the person's own Claude Code login).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import http from 'http';
import { machineCa, startKeyInjector, type MachineCa } from '../airlock/keyInjector';
import { cachedToken, localTokenSource, TokenSourceError, tokenErrorMessage, type TokenSource } from '../airlock/tokenSource';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-token-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const REQ = { provider: 'anthropic' as const, subject: 'dana' };

function source(tokens: string[], ttlMs = 3_600_000, clock: () => number = Date.now) {
  let i = 0;
  const s: TokenSource & { get: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } = {
    get: vi.fn(async () => ({ accessToken: tokens[Math.min(i++, tokens.length - 1)], expiresAt: clock() + ttlMs })),
    invalidate: vi.fn(async () => undefined),
  };
  return s;
}

describe('cachedToken', () => {
  it('asks the source once and serves the cached token until 60 s before it expires', async () => {
    let now = 1_000_000;
    const s = source(['t1', 't2'], 120_000, () => now);
    const t = cachedToken(s, REQ, () => now);
    expect(await t.get()).toBe('t1');
    now += 59_000;
    expect(await t.get()).toBe('t1');
    expect(s.get).toHaveBeenCalledTimes(1);
    now += 2_000; // 61 s before expiry has passed
    expect(await t.get()).toBe('t2');
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(s.get).toHaveBeenCalledWith(REQ);
  });

  it('asks once for callers waiting together', async () => {
    const s = source(['t1']);
    const t = cachedToken(s, REQ);
    expect(await Promise.all([t.get(), t.get(), t.get()])).toEqual(['t1', 't1', 't1']);
    expect(s.get).toHaveBeenCalledTimes(1);
  });

  it('invalidate tells the source which token failed and drops it, so the next get asks again', async () => {
    const s = source(['t1', 't2']);
    const t = cachedToken(s, REQ);
    await t.get();
    await t.invalidate('t1');
    expect(s.invalidate).toHaveBeenCalledWith(REQ, 't1');
    expect(await t.get()).toBe('t2');
  });

  it('a stale invalidate (a token already replaced) keeps the current one', async () => {
    const s = source(['t1', 't2']);
    const t = cachedToken(s, REQ);
    await t.get(); await t.invalidate('t1'); await t.get();
    await t.invalidate('t1');
    expect(await t.get()).toBe('t2');
    expect(s.get).toHaveBeenCalledTimes(2);
  });
});

describe('tokenErrorMessage', () => {
  it('says what to do for each code', () => {
    expect(tokenErrorMessage(new TokenSourceError('not_connected'), 'claude')).toMatch(/not connected[\s\S]*claude[\s\S]*\/login[\s\S]*--login mount/i);
    expect(tokenErrorMessage(new TokenSourceError('at_limit', Date.UTC(2026, 10, 4, 18)), 'claude')).toMatch(/limit[\s\S]*2026-11-04T18:00:00/);
    expect(tokenErrorMessage(new TokenSourceError('revoked'), 'claude')).toMatch(/revoked[\s\S]*log in again/i);
  });
});

describe('localTokenSource (anthropic): the person\'s own Claude Code login', () => {
  const login = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-live', refreshToken: 'r', expiresAt } });

  it('reads the macOS Keychain on a Mac', async () => {
    const readKeychain = vi.fn(() => login(Date.now() + 3_600_000));
    const s = localTokenSource({ platform: 'darwin', home: dir, readKeychain });
    expect(await s.get(REQ)).toMatchObject({ accessToken: 'sk-ant-oat-live' });
    expect(readKeychain).toHaveBeenCalledWith('Claude Code-credentials');
  });

  it('reads ~/.claude/.credentials.json elsewhere (or CLAUDE_CONFIG_DIR\'s)', async () => {
    fs.mkdirSync(path.join(dir, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cfg', '.credentials.json'), login(Date.now() + 3_600_000));
    const s = localTokenSource({ platform: 'linux', home: dir, claudeConfigDir: path.join(dir, 'cfg') });
    const t = await s.get(REQ);
    expect(t.accessToken).toBe('sk-ant-oat-live');
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it('no login is not_connected', async () => {
    const s = localTokenSource({ platform: 'darwin', home: dir, readKeychain: () => null });
    await expect(s.get(REQ)).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('an expired login is not_connected too (Airlock never refreshes it; Claude Code on the host does)', async () => {
    const s = localTokenSource({ platform: 'darwin', home: dir, readKeychain: () => login(Date.now() - 1000) });
    await expect(s.get(REQ)).rejects.toMatchObject({ code: 'not_connected', message: expect.stringMatching(/expired/) });
  });

});

/** A JWT as ChatGPT's access tokens are: the claims carry exp (seconds). */
const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'RS256', typ: 'JWT' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.c2ln';

describe('localTokenSource (openai): the person\'s own Codex ChatGPT login (b3a0992f)', () => {
  const OPENAI = { provider: 'openai' as const, subject: 'dana' };
  const write = (dirPath: string, tokens: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, ...(tokens ? { tokens } : {}), ...extra }));
  };

  it('reads ~/.codex/auth.json: the access token, when it expires (its JWT exp) and the account it is for', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    write(path.join(dir, '.codex'), { access_token: jwt({ exp }), refresh_token: 'host-refresh', id_token: jwt({}), account_id: 'acct-1' });
    const t = await localTokenSource({ platform: 'darwin', home: dir, readKeychain: () => null }).get(OPENAI);
    expect(t).toMatchObject({ accessToken: jwt({ exp }), accountId: 'acct-1', expiresAt: exp * 1000 });
  });

  it('reads CODEX_HOME\'s auth.json when the user set one', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    write(path.join(dir, 'cx'), { access_token: jwt({ exp }), account_id: 'acct-2' });
    write(path.join(dir, '.codex'), { access_token: jwt({ exp }), account_id: 'acct-wrong' });
    const t = await localTokenSource({ platform: 'linux', home: dir, codexHome: path.join(dir, 'cx') }).get(OPENAI);
    expect(t.accountId).toBe('acct-2');
  });

  it('an access token that is no JWT is held a short while, as a Claude login without expiresAt is', async () => {
    write(path.join(dir, '.codex'), { access_token: 'opaque', account_id: 'acct-1' });
    const t = await localTokenSource({ platform: 'linux', home: dir }).get(OPENAI);
    expect(t.accessToken).toBe('opaque');
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it('no login file, or one with an API key only, is not_connected, saying a keyring login is not read', async () => {
    const s = localTokenSource({ platform: 'linux', home: dir });
    await expect(s.get(OPENAI)).rejects.toMatchObject({ code: 'not_connected', message: expect.stringMatching(/keyring/) });
    write(path.join(dir, '.codex'), null, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' });
    await expect(s.get(OPENAI)).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('an expired login is not_connected: Airlock never refreshes it, codex on the host does', async () => {
    write(path.join(dir, '.codex'), { access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }), refresh_token: 'r', account_id: 'acct-1' });
    await expect(localTokenSource({ platform: 'linux', home: dir }).get(OPENAI))
      .rejects.toMatchObject({ code: 'not_connected', message: expect.stringMatching(/expired[\s\S]*codex/) });
  });

  it('reads the file again on every get: what codex on the host refreshed is what the next ask gets', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    write(path.join(dir, '.codex'), { access_token: jwt({ exp, n: 1 }), account_id: 'acct-1' });
    const s = localTokenSource({ platform: 'linux', home: dir });
    expect((await s.get(OPENAI)).accessToken).toBe(jwt({ exp, n: 1 }));
    write(path.join(dir, '.codex'), { access_token: jwt({ exp, n: 2 }), account_id: 'acct-1' });
    expect((await s.get(OPENAI)).accessToken).toBe(jwt({ exp, n: 2 }));
  });

  it('a codex login error says how codex logs in', () => {
    expect(tokenErrorMessage(new TokenSourceError('not_connected'), 'codex')).toMatch(/codex login/);
    expect(tokenErrorMessage(new TokenSourceError('not_connected'), 'codex')).not.toMatch(/\/login/);
  });
});

describe('cachedToken.token(): the whole token, for what a stand-in login needs beside it (the account)', () => {
  it('gives the cached token with its accountId, asking the source once', async () => {
    const s: TokenSource = { get: vi.fn(async () => ({ accessToken: 't1', expiresAt: Date.now() + 3_600_000, accountId: 'acct-1' })), invalidate: vi.fn(async () => undefined) };
    const t = cachedToken(s, REQ);
    expect(await t.token()).toMatchObject({ accessToken: 't1', accountId: 'acct-1' });
    expect(await t.get()).toBe('t1');
    expect(s.get).toHaveBeenCalledTimes(1);
  });
});

describe('startKeyInjector: a token the host holds', () => {
  let ca: MachineCa;
  let upstream: http.Server;
  let port: number;
  let answers: number[];
  /** How long the upstream takes to answer, and whether it cuts a 401 off mid-body. */
  let delayMs = 0;
  let cut401 = false;
  let seen: Array<{ auth?: string; body: string }>;
  let injector: { port: number; close(): Promise<void> } | null = null;
  const PH = 'airlock_ph_tokentokentokentoken';

  beforeEach(async () => {
    ca = machineCa(dir);
    seen = [];
    answers = [200];
    delayMs = 0;
    cut401 = false;
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body });
        const status = answers.shift() ?? 200;
        if (status === 401 && cut401) {
          res.writeHead(401, { 'content-length': '100' });
          res.write('partial');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        setTimeout(() => res.writeHead(status).end(status === 200 ? 'ok' : 'unauthorized'), delayMs);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    port = (upstream.address() as { port: number }).port;
  });
  afterEach(async () => {
    await injector?.close();
    injector = null;
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const start = async (token: { get(): Promise<string>; invalidate(stale: string): Promise<void> }) => {
    injector = await startKeyInjector({
      ca, routes: [{ host: 'api.anthropic.test', port: 443 }],
      secrets: [{ placeholder: PH, token }],
      connectUpstream: () => ({ protocol: 'http:', hostname: '127.0.0.1', port }),
    });
  };
  const post = (body: string): Promise<{ status: number; body: string }> => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: injector!.port, method: 'POST', path: '/v1/messages',
      headers: { host: 'api.anthropic.test', authorization: `Bearer ${PH}` },
      createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.anthropic.test', ca: ca.certPem }),
    }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });

  it('puts the token the source gives where the stand-in is', async () => {
    await start(cachedToken(source(['live-1']), REQ));
    expect((await post('{"q":1}')).status).toBe(200);
    expect(seen).toEqual([{ auth: 'Bearer live-1', body: '{"q":1}' }]);
  });

  it('on a 401, invalidates the token, asks once more and sends the same request again', async () => {
    const s = source(['live-1', 'live-2']);
    await start(cachedToken(s, REQ));
    answers = [401, 200];
    const r = await post('{"q":2}');
    expect(r).toEqual({ status: 200, body: 'ok' });
    expect(s.invalidate).toHaveBeenCalledWith(REQ, 'live-1');
    expect(seen).toEqual([{ auth: 'Bearer live-1', body: '{"q":2}' }, { auth: 'Bearer live-2', body: '{"q":2}' }]);
  });

  it('a second 401 is the answer: no loop', async () => {
    await start(cachedToken(source(['live-1', 'live-2', 'live-3']), REQ));
    answers = [401, 401, 200];
    expect((await post('{}')).status).toBe(401);
    expect(seen).toHaveLength(2);
  });

  // Review (GH-356): a request waiting for its token holds a slot, so the guest cannot pile up held bodies.
  it('requests waiting for a token count against the 64 at once: the 65th is answered 503', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    await start({ get: async () => { await blocked; return 'live-1'; }, invalidate: async () => undefined });
    const pending = Array.from({ length: 64 }, () => post('{}'));
    await new Promise((r) => setTimeout(r, 300));
    expect((await post('{}')).status).toBe(503);
    unblock();
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
  });

  it('a token request upstream keeps its slot until its answer ends (review): the 65th waits behind 64 slow ones', async () => {
    await start(cachedToken(source(['live-1']), REQ));
    delayMs = 800;
    const pending = Array.from({ length: 64 }, () => post('{}'));
    await new Promise((r) => setTimeout(r, 300));
    expect((await post('{}')).status).toBe(503);
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
    delayMs = 0;
    expect((await post('{}')).status).toBe(200);
  });

  it('a 401 cut off mid-answer still gets its retry, and the injector keeps serving', async () => {
    await start(cachedToken(source(['live-1', 'live-2']), REQ));
    answers = [401, 200];
    cut401 = true;
    expect((await post('{"q":3}')).status).toBe(200);
    expect((await post('{}')).status).toBe(200);
  });

  it('a guest that leaves while its token is asked for keeps its slot until the ask ends (review)', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    await start({ get: async () => { await blocked; return 'live-1'; }, invalidate: async () => undefined });
    const reqs: http.ClientRequest[] = [];
    for (let i = 0; i < 64; i++) {
      const req = http.request({
        host: '127.0.0.1', port: injector!.port, method: 'POST', path: '/v1/messages',
        headers: { host: 'api.anthropic.test', authorization: `Bearer ${PH}` },
        createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.anthropic.test', ca: ca.certPem }),
      });
      req.on('error', () => undefined);
      req.end('x'.repeat(1024));
      reqs.push(req);
    }
    // Every one admitted and asking, then gone.
    await new Promise((r) => setTimeout(r, 2000));
    for (const r of reqs) r.destroy();
    await new Promise((r) => setTimeout(r, 300));
    try {
      expect((await post('{}')).status).toBe(503);
    } finally {
      unblock();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect((await post('{}')).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('sends nothing upstream when the guest has gone while its token was being asked for', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    await start({ get: async () => { await blocked; return 'live-1'; }, invalidate: async () => undefined });
    const req = http.request({
      host: '127.0.0.1', port: injector!.port, method: 'POST', path: '/v1/messages',
      headers: { host: 'api.anthropic.test', authorization: `Bearer ${PH}` },
      createConnection: () => tls.connect({ host: '127.0.0.1', port: injector!.port, servername: 'api.anthropic.test', ca: ca.certPem }),
    });
    req.on('error', () => undefined);
    req.end('{}');
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    unblock();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([]);
  });

  it('a token Node refuses in a header (CR/LF) is answered 502, not a launcher crash (b3a0992f review)', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      await start({ get: async () => 'live\r\nx-evil: 1', invalidate: async () => undefined });
      expect((await post('{}')).status).toBe(502);
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a source that cannot give a token is answered 502, and nothing goes upstream', async () => {
    await start({ get: async () => { throw new TokenSourceError('revoked'); }, invalidate: async () => undefined });
    const r = await post('{}');
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/revoked/);
    expect(seen).toEqual([]);
  });
});
