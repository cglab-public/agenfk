/**
 * CGLAB-165: the API server can also serve the built UI bundle, so the desktop
 * shell has a single origin for REST + Socket.io + assets and no second
 * `vite preview` process to supervise.
 *
 * Two invariants the suite pins down, because both are easy to break:
 *   1. Opt-in. With no AGENFK_SERVE_UI and nothing mounted, the server behaves
 *      byte-for-byte as it does today (the `agenfk up` web flow).
 *   2. `GET /` keeps answering JSON to API clients. `agenfk health` reads
 *      `.message` from it, so serving index.html unconditionally there would
 *      silently break the health check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, resolveUiDir, mountStaticUI, API_PATH_PREFIXES } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. That
 * churn produced `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` — a
 * transport failure, not an assertion about anything under test. It hands the
 * test an empty body, so `res.body.id` is undefined and the next call goes to
 * `/items/undefined`; one bad socket then surfaces as `expected 404 to be 400`
 * in whichever test happened to be running. Different test every run, green
 * when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./serve-ui-test-db.sqlite');

const INDEX_HTML = '<!doctype html><title>AgEnFK</title><div id="root"></div>';
const APP_JS = 'console.log("agenfk ui bundle");';

let uiDir: string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();

  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ui-dist-'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(uiDir, 'assets'));
  fs.writeFileSync(path.join(uiDir, 'assets', 'app.js'), APP_JS);
});

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true });
});

// ── Ordering note ────────────────────────────────────────────────────────────
// mountStaticUI installs middleware on the shared `app` and cannot be undone,
// so the "not mounted" expectations must run first. Vitest keeps declaration
// order within a file (root config sets sequence.concurrent: false).

describe('resolveUiDir', () => {
  it('returns null when no candidate directory holds an index.html', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ui-empty-'));
    try {
      expect(resolveUiDir(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns null for a path that does not exist at all', () => {
    expect(resolveUiDir(path.join(os.tmpdir(), 'agenfk-does-not-exist-12345'))).toBeNull();
  });

  it('returns the explicit directory when it holds an index.html', () => {
    expect(resolveUiDir(uiDir)).toBe(uiDir);
  });

  it('never substitutes another bundle for a bad explicit path', () => {
    // Regression guard against a probing fallback: an operator who mistyped
    // AGENFK_SERVE_UI must get "API only", never somebody else's build served
    // silently. Staged with a REAL probeable bundle present, otherwise the
    // assertion is vacuous — a reintroduced fallback would return null anyway
    // on a machine that has no packages/ui/dist.
    const fakeShipped = path.resolve(__dirname, '../../../ui/dist');
    const staged = !fs.existsSync(path.join(fakeShipped, 'index.html'));
    if (staged) {
      fs.mkdirSync(fakeShipped, { recursive: true });
      fs.writeFileSync(path.join(fakeShipped, 'index.html'), '<!doctype html>probe-target');
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ui-empty-'));
    try {
      expect(resolveUiDir(path.join(fakeShipped, 'index.html'))).not.toBe(fakeShipped);
      expect(resolveUiDir(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      if (staged) fs.rmSync(path.join(fakeShipped, 'index.html'), { force: true });
    }
  });

  it('refuses a source tree that merely happens to contain an index.html', () => {
    // packages/ui/index.html is Vite's entry template, so the one-token typo
    // `AGENFK_SERVE_UI=packages/ui` (for .../dist) must NOT be accepted —
    // it would expose src/, package.json and node_modules over the API port.
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ui-srcroot-'));
    try {
      fs.writeFileSync(path.join(srcRoot, 'index.html'), '<!doctype html>');
      fs.mkdirSync(path.join(srcRoot, 'src'));
      fs.mkdirSync(path.join(srcRoot, 'node_modules'));
      expect(resolveUiDir(srcRoot)).toBeNull();
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
    }
  });

  it('treats a boolean-looking value as "probe", not as a directory name', () => {
    // Someone reading AGENFK_SERVE_UI as a flag will export it as 1/true.
    // That must not be interpreted as a relative path called "1".
    for (const sentinel of ['1', 'true', 'auto', 'YES']) {
      expect(() => resolveUiDir(sentinel)).not.toThrow();
      expect(resolveUiDir(sentinel)).not.toBe(sentinel);
    }
  });
});

describe('with no UI bundle mounted (today\'s `agenfk up` behaviour)', () => {
  it('GET / answers the API status JSON even to a browser', async () => {
    const res = await agent().get('/').set('Accept', 'text/html,application/xhtml+xml');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('AgEnFK Framework API is running');
  });

  it('does not serve UI assets', async () => {
    const res = await agent().get('/assets/app.js');
    expect(res.status).toBe(404);
  });
});

describe('with the UI bundle mounted (desktop / AGENFK_SERVE_UI)', () => {
  beforeAll(() => {
    mountStaticUI(app, uiDir);
  });

  it('GET / still answers JSON to API clients, so agenfk health keeps working', async () => {
    const res = await agent().get('/').set('Accept', 'application/json, text/plain, */*');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('AgEnFK Framework API is running');
  });

  it('GET / answers JSON to a client that sends no Accept preference (curl)', async () => {
    const res = await agent().get('/').set('Accept', '*/*');
    expect(res.body.message).toBe('AgEnFK Framework API is running');
  });

  it('GET / serves the SPA shell to a browser', async () => {
    const res = await agent().get('/').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<div id="root">');
  });

  it('serves hashed assets with a sensible content type', async () => {
    const res = await agent().get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe(APP_JS);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('falls back to the SPA shell for a deep-linked UI route', async () => {
    const res = await agent().get('/board/some-project').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('does not shadow existing API routes', async () => {
    const res = await agent().get('/version').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.body.version).toBeTruthy();
    expect(res.text).not.toContain('<div id="root">');
  });

  it('lets an unknown API path 404 as JSON instead of swallowing it into the SPA', async () => {
    const res = await agent().get('/projects/definitely-not-a-project').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('refuses the SPA for an API-prefixed path that matches NO route at all', async () => {
    // The test above is answered by the route itself, so it exercises the
    // headersSent guard rather than API_PATH_PREFIXES. These reach the
    // fallback with nothing sent, so only the prefix list can reject them.
    for (const p of ['/projects/a/b/c', '/items/x/y', '/agent-runs/1/2/3']) {
      const res = await agent().get(p).set('Accept', 'text/html');
      expect(res.text, `${p} leaked the SPA shell`).not.toContain('<div id="root">');
    }
  });

  it('keeps API_PATH_PREFIXES covering every top-level route registered in the server', () => {
    // Drift guard: a new namespace added to the route table without being
    // listed here would start answering the SPA shell on its unmatched paths.
    const source = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    const registered = new Set<string>();
    for (const m of source.matchAll(/^app\.(?:get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/gm)) {
      const first = '/' + m[1].split('/')[1];
      if (first !== '/') registered.add(first);
    }
    expect(registered.size).toBeGreaterThan(5); // the scrape actually found routes
    const missing = [...registered].filter(p => !API_PATH_PREFIXES.includes(p));
    expect(missing, `route namespaces missing from API_PATH_PREFIXES: ${missing.join(', ')}`).toEqual([]);
  });

  it('answers HEAD and GET consistently on a SPA path', async () => {
    const get = await agent().get('/deep/link').set('Accept', 'text/html');
    const head = await agent().head('/deep/link').set('Accept', 'text/html');
    expect(get.status).toBe(200);
    expect(head.status).toBe(get.status);
  });

  it('denies dotfiles instead of serving them', async () => {
    fs.writeFileSync(path.join(uiDir, '.env'), 'SECRET=hunter2');
    try {
      const res = await agent().get('/.env').set('Accept', '*/*');
      expect(res.status).not.toBe(200);
      expect(res.text ?? '').not.toContain('hunter2');
    } finally {
      fs.rmSync(path.join(uiDir, '.env'), { force: true });
    }
  });

  it('marks hashed assets immutable but never the shell', async () => {
    const asset = await agent().get('/assets/app.js');
    expect(asset.headers['cache-control']).toMatch(/immutable/);

    const shell = await agent().get('/').set('Accept', 'text/html');
    expect(shell.headers['cache-control'] ?? '').not.toMatch(/immutable/);
  });

  it('serves the shell from one source — "/" and a deep link agree byte for byte', async () => {
    // If "/" came off disk via express.static's index while deep links came
    // from the boot snapshot, a bundle swap would desync them.
    const root = await agent().get('/').set('Accept', 'text/html');
    const deep = await agent().get('/deep/link').set('Accept', 'text/html');
    expect(root.text).toBe(deep.text);
  });

  it('does not hijack Socket.io polling requests', async () => {
    const res = await agent().get('/socket.io/?EIO=4&transport=polling').set('Accept', 'text/html');
    expect(res.text).not.toContain('<div id="root">');
  });

  it('does not answer non-GET requests with the SPA shell', async () => {
    const res = await agent().post('/not/a/real/endpoint').set('Accept', 'text/html').send({});
    expect(res.text).not.toContain('<div id="root">');
  });

  it('does not serve the SPA shell to a non-browser client on an unknown path', async () => {
    const res = await agent().get('/some/unknown/path').set('Accept', 'application/json');
    expect(res.text).not.toContain('<div id="root">');
  });
});
