/**
 * Security audit, Fix 6 (AEF-5): the hub answered with no security headers at
 * all - only `X-Powered-By: Express`. No nosniff, no framing policy, no
 * referrer policy, no CSP, no HSTS. This pins what it sends now, per response
 * class, because the one that can break the product is the CSP on the SPA:
 *
 *  - every response: no X-Powered-By, nosniff, Referrer-Policy, X-Frame-Options
 *    DENY (nothing frames the hub: no iframe in ui/hub-ui/flow-editor, and the
 *    desktop app loadURL()s a top-level window);
 *  - HSTS only when the request really arrived over TLS (req.secure, so only as
 *    trustworthy as AGENFK_HUB_TRUST_PROXY), never over plain HTTP;
 *  - the SPA shell gets a CSP that allows its own origin, its one inline script
 *    (the pre-paint theme bootstrap) by sha256 hash, not 'unsafe-inline', and
 *    no eval;
 *  - everything else (JSON, static assets) gets a lock-down CSP that loads
 *    nothing and cannot be framed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { inlineScriptHashes, htmlCsp, API_CSP } from '../util/securityHeaders';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-sec-headers-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };
const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const INLINE_A = "var a = 1; // theme bootstrap\n";
const INLINE_B = 'window.b = 2';
const FIXTURE_HTML = `<!doctype html><html><head><title>t</title>
<script>${INLINE_A}</script>
<script type="module" src="/assets/app.js"></script>
</head><body><div id="root"></div><script>${INLINE_B}</script></body></html>`;

let uiDir = '';
let server: any = null;
let ctx: any = null;
let savedUiDir: string | undefined;

async function boot(opts: { trustProxy?: number | string; defaultOrgId?: string } = {}) {
  if (server) { await drainApp(server); server = null; }
  if (ctx) { ctx.stopWorkers?.(); await ctx.db.close(); ctx = null; }
  const out = await createHubApp({
    dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: opts.defaultOrgId ?? 'org',
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
}
const get = (p: string, headers: Record<string, string> = {}) => supertest(server).get(p).set(headers);
const directives = (csp: string): Record<string, string> =>
  Object.fromEntries(csp.split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')]; }));

beforeEach(async () => {
  cleanup();
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ui-fixture-'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), FIXTURE_HTML);
  fs.mkdirSync(path.join(uiDir, 'assets'));
  fs.writeFileSync(path.join(uiDir, 'assets', 'app.js'), 'console.log("app")');
  savedUiDir = process.env.AGENFK_HUB_UI_DIR;
  process.env.AGENFK_HUB_UI_DIR = uiDir;
  await boot();
});
afterEach(async () => {
  if (savedUiDir === undefined) delete process.env.AGENFK_HUB_UI_DIR; else process.env.AGENFK_HUB_UI_DIR = savedUiDir;
  if (server) await drainApp(server);
  if (ctx) { ctx.stopWorkers?.(); await ctx.db.close(); }
  server = null; ctx = null;
  fs.rmSync(uiDir, { recursive: true, force: true });
  cleanup();
});

describe('headers on every response', () => {
  it.each([
    ['the SPA shell', '/'],
    ['an SPA deep link', '/admin/keys'],
    ['a static asset', '/assets/app.js'],
    ['/healthz', '/healthz'],
    ['a public API route', '/auth/providers'],
    ['a refused API route (401)', '/v1/ping'],
    ['a missing API route', '/v1/nothing-here'],
  ])('%s: no X-Powered-By, nosniff, referrer policy, no framing', async (_label, p) => {
    const r = await get(p);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy'], 'every response carries a CSP').toBeTruthy();
  });

  it('also on a body-parser error (malformed JSON), which never reaches a route', async () => {
    const r = await supertest(server).post('/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(r.status).toBe(400);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Strict-Transport-Security', () => {
  const HSTS = 'max-age=15552000; includeSubDomains';

  it('is not sent over plain HTTP', async () => {
    expect((await get('/healthz')).headers['strict-transport-security']).toBeUndefined();
    expect((await get('/')).headers['strict-transport-security']).toBeUndefined();
  });

  it('is sent when the request arrived over TLS behind the trusted proxy', async () => {
    for (const p of ['/healthz', '/', '/v1/ping']) {
      expect((await get(p, { 'X-Forwarded-Proto': 'https' })).headers['strict-transport-security'], p).toBe(HSTS);
    }
  });

  it('is not sent when the proxy says the hop was http', async () => {
    expect((await get('/healthz', { 'X-Forwarded-Proto': 'http' })).headers['strict-transport-security']).toBeUndefined();
  });

  it('cannot be forced by a client header when no proxy is trusted (AGENFK_HUB_TRUST_PROXY=0): it only follows req.secure', async () => {
    await boot({ trustProxy: 0 });
    expect((await get('/healthz', { 'X-Forwarded-Proto': 'https' })).headers['strict-transport-security']).toBeUndefined();
  });
});

describe('Content-Security-Policy', () => {
  it('the SPA shell allows its origin and exactly its inline scripts by hash, with no unsafe-inline or eval for scripts', async () => {
    for (const p of ['/', '/admin/keys']) {
      const csp = (await get(p)).headers['content-security-policy'];
      const d = directives(csp);
      expect(d['default-src'], p).toBe("'self'");
      expect(d['script-src'], p).toBe(`'self' ${sha(INLINE_A)} ${sha(INLINE_B)}`);
      expect(d['script-src']).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(d['frame-ancestors']).toBe("'none'");
      expect(d['object-src']).toBe("'none'");
      expect(d['base-uri']).toBe("'self'");
      expect(d['connect-src']).toBe("'self'");
      expect(d['img-src']).toBe("'self' data:");
      expect(d['font-src']).toBe("'self' data:");
      expect(d['form-action']).toBe("'self'");
      // The one deliberate loosening: the SPA sets inline style attributes.
      expect(d['style-src']).toBe("'self' 'unsafe-inline'");
    }
  });

  it('serves index.html requested directly (static) with the SPA policy, not the lock-down one', async () => {
    const d = directives((await get('/index.html')).headers['content-security-policy']);
    expect(d['default-src']).toBe("'self'");
    expect(d['script-src']).toContain(sha(INLINE_A));
  });

  it('serves / , /index.html and deep links from the one in-memory copy, so the policy always matches the page', async () => {
    // Replace the file under the running hub: nothing may be served from disk.
    fs.writeFileSync(path.join(uiDir, 'index.html'), FIXTURE_HTML.replace('window.b = 2', 'window.b = 3'));
    for (const p of ['/', '/index.html', '/admin/keys']) {
      const r = await get(p);
      expect(r.text, p).toContain('window.b = 2');
      expect(r.text, p).not.toContain('window.b = 3');
      expect(directives(r.headers['content-security-policy'])['script-src'], p).toContain(sha(INLINE_B));
    }
  });

  it('answers HEAD for the shell like GET (a probe of / must not see the hub as down)', async () => {
    for (const p of ['/', '/index.html']) {
      const r = await supertest(server).head(p);
      expect(r.status, p).toBe(200);
      expect(directives(r.headers['content-security-policy'])['script-src'], p).toContain(sha(INLINE_A));
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('JSON and static assets get the lock-down policy: nothing loads, nothing frames', async () => {
    for (const p of ['/healthz', '/auth/providers', '/v1/ping', '/assets/app.js']) {
      expect((await get(p)).headers['content-security-policy'], p).toBe(API_CSP);
    }
    const d = directives(API_CSP);
    expect(d['default-src']).toBe("'none'");
    expect(d['frame-ancestors']).toBe("'none'");
  });

  it('the real hub-ui/index.html: every inline script it contains is allowed, so a CSP never blanks the UI', async () => {
    const real = fs.readFileSync(path.resolve(__dirname, '../../../hub-ui/index.html'), 'utf8');
    const hashes = inlineScriptHashes(real);
    // The pre-paint theme bootstrap is the only inline script today. If this
    // count changes, a new inline script was added: it is hashed automatically,
    // but whoever adds it should know the CSP now depends on it.
    expect(hashes.length).toBe(1);
    fs.writeFileSync(path.join(uiDir, 'index.html'), real);
    await boot();
    const d = directives((await get('/')).headers['content-security-policy']);
    for (const h of hashes) expect(d['script-src']).toContain(h);
  });
});

describe('inlineScriptHashes', () => {
  it('hashes the exact text of each inline script, in order', () => {
    expect(inlineScriptHashes(FIXTURE_HTML)).toEqual([sha(INLINE_A), sha(INLINE_B)]);
  });
  it('ignores external scripts, however they are written', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script><SCRIPT SRC=/b.js></SCRIPT><script type="module" crossorigin src="/c.js"></script>')).toEqual([]);
  });
  it('finds inline scripts regardless of tag case or attributes', () => {
    expect(inlineScriptHashes('<SCRIPT type="module">x()</SCRIPT>')).toEqual([sha('x()')]);
  });
  it('hashes what the browser hashes when the file has Windows line endings (the parser normalises CRLF and CR to LF)', () => {
    expect(inlineScriptHashes('<script>a();\r\nb();\r\n</script>')).toEqual([sha('a();\nb();\n')]);
    expect(inlineScriptHashes('<script>a();\rb();</script>')).toEqual([sha('a();\nb();')]);
  });
  it('de-duplicates identical scripts', () => {
    expect(inlineScriptHashes('<script>x()</script><script>x()</script>')).toEqual([sha('x()')]);
  });
  it('htmlCsp with no inline scripts allows none', () => {
    expect(directives(htmlCsp([]))['script-src']).toBe("'self'");
  });
});

describe('the maintenance app (boot refused on an org-id mismatch) carries them too', () => {
  it('serves its HTML page and its JSON answers with the headers, and a CSP its inline <style> can live under', async () => {
    // First boot seeds org "org"; the second names another, so the hub refuses to boot normally.
    await boot({ defaultOrgId: 'some-other-org' });
    const html = await get('/', { Accept: 'text/html' });
    expect(html.status).toBe(503);
    expect(html.headers['x-powered-by']).toBeUndefined();
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['x-frame-options']).toBe('DENY');
    const d = directives(html.headers['content-security-policy']);
    expect(d['style-src']).toContain("'unsafe-inline'");
    expect(d['script-src']).toBe("'self'");
    expect(d['frame-ancestors']).toBe("'none'");

    const json = await get('/healthz');
    expect(json.status).toBe(503);
    expect(json.headers['content-security-policy']).toBe(API_CSP);
    expect(json.headers['x-content-type-options']).toBe('nosniff');
    expect((await get('/healthz', { 'X-Forwarded-Proto': 'https' })).headers['strict-transport-security']).toBeDefined();
  });
});
