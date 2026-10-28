/**
 * Airlock layer 2 (GH-294, L2-3): sandbox conformance. The spike's checks
 * (airlock-spike.md), run against the PINNED Sandbox Runtime with the spec and
 * the command line AgEnFK really builds, so a version bump that breaks one of
 * these guarantees goes red.
 *
 * Really sandboxes processes, so it runs only where the runtime can (macOS, or
 * Linux with bwrap/socat/rg); elsewhere each check is skipped with the reason.
 * It contacts only api.github.com, github.com, example.com and the metadata
 * address, plus two loopback servers of its own. Credential files are dummies
 * under a temp HOME; no real credential store is read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn, spawnSync } from 'child_process';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSpec } from '../airlock/spec';
import { findAgenfkDirs } from '../airlock/launch';
import { toAsrtConfig, sandboxCommandLine, sandboxStartFailure, sandboxNoop, ASRT_VERSION } from '../airlock/runtime';
import { startServerRelay, type ServerRelay } from '../airlock/serverRelay';

const DRIVER = path.resolve(__dirname, 'fixtures/airlock-conformance-driver.mjs');
const AIRLOCK_SCRIPT = path.resolve(__dirname, '../../../../bin/agenfk-airlock.mjs');
const ZEN = 'https://api.github.com/zen';
const GITHUB = 'https://github.com/';
const TIMEOUT = 180_000;

type Result = { name: string; code: number | null; signal: string | null; stdout: string; stderr: string };

let root = '';
let home = '';
let ws = '';
let skipAll: string | null = null;
let check: any = null;
let pre: any = { reachable: {}, addresses: {} };
const results: Record<string, Result> = {};
const servers: http.Server[] = [];
const FAKE_KEY = `real-secret-${Math.random().toString(36).slice(2)}`;
const RELAY_MARK = 'v1.conformance.' + 'd'.repeat(64);
let relay: ServerRelay | null = null;
const echoSeen: string[] = [];

/** Run the driver in its own process (async: the loopback servers live in this one). */
function driver(request: unknown, env: NodeJS.ProcessEnv = process.env): Promise<any> {
  const file = path.join(root, `req-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(request));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER, file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => {
      try {
        const parsed = JSON.parse(out);
        if (parsed?.driverError) reject(new Error(parsed.driverError));
        else resolve(parsed);
      } catch {
        reject(new Error(`driver gave no JSON. stdout: ${out.slice(0, 500)} stderr: ${err.slice(0, 1500)}`));
      }
    });
  });
}

function serve(body: string): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer((_q, r) => { r.end(body); });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
  });
}

let injectSeen: string | null = null;

/** A self-signed certificate for localhost, or null when openssl is missing. */
function tlsMaterial(): { key: string; cert: string } | null {
  const key = path.join(root, 'tls.key');
  const cert = path.join(root, 'tls.crt');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
}

/** An authenticated HTTPS endpoint: answers whether it got the REAL key (never echoes it). */
function serveTls(tls: { key: string; cert: string }): Promise<number> {
  return new Promise((resolve) => {
    const s = https.createServer(tls, (q, r) => {
      const auth = String(q.headers.authorization ?? '');
      injectSeen = auth === `Bearer ${FAKE_KEY}` ? 'real' : auth ? 'stand-in' : 'none';
      r.end(injectSeen);
    });
    servers.push(s as unknown as http.Server);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
  });
}

const PROBE = `
const fs = require('fs'); const net = require('net');
const [action, a, b] = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
(async () => {
  if (action === 'fetch') {
    try { const r = await fetch(a, { signal: AbortSignal.timeout(15000) }); say({ status: r.status, proxyError: r.headers.get('x-proxy-error'), body: (await r.text()).slice(0, 200) }); }
    catch (e) { say({ error: String(e.cause?.code || e.cause?.message || e.message) }); }
  } else if (action === 'connect') {
    const s = net.connect({ host: a, port: Number(b) });
    const t = setTimeout(() => { say({ error: 'TIMEOUT' }); s.destroy(); }, 8000);
    s.on('connect', () => { clearTimeout(t); say({ connected: true }); s.destroy(); });
    s.on('error', (e) => { clearTimeout(t); say({ error: e.code || e.message }); });
  } else if (action === 'read') {
    try { say({ read: fs.readFileSync(a, 'utf8').length }); } catch (e) { say({ error: e.code }); }
  } else if (action === 'write') {
    try { fs.mkdirSync(require('path').dirname(a), { recursive: true }); fs.writeFileSync(a, 'x'); say({ wrote: true }); } catch (e) { say({ error: e.code }); }
  } else if (action === 'env') {
    say({ value: process.env[a] ?? null });
  } else if (action === 'fetchauth') {
    try { const r = await fetch(a, { headers: { authorization: 'Bearer ' + process.env[b] }, signal: AbortSignal.timeout(15000) }); say({ status: r.status, body: await r.text() }); }
    catch (e) { say({ error: String(e.cause?.code || e.cause?.message || e.message) }); }
  } else if (action === 'gate') {
    const m = await import(require('url').pathToFileURL(a).href);
    say(await m.airlockSandboxCheck({ env: process.env, homeDir: b }));
  } else if (action === 'ownserver') {
    const http = require('http');
    const s = http.createServer((q, r) => r.end('own'));
    s.on('error', (e) => { say({ error: e.code }); process.exit(0); });
    s.listen(0, '127.0.0.1', () => {
      http.get('http://127.0.0.1:' + s.address().port + '/', (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { say({ body: b }); process.exit(0); }); })
        .on('error', (e) => { say({ error: e.code || e.message }); process.exit(0); });
    });
  } else if (action === 'raw') {
    process.stdin.setRawMode(true); say({ raw: true }); process.exit(0);
  }
})();
`;

const parse = (r: Result | undefined): any => {
  if (!r) return null;
  // A pty echoes control bytes ahead of the JSON, so take the object, not the line.
  const line = r.stdout.split('\n').map((l) => /\{.*\}/.exec(l)?.[0]).filter(Boolean).pop();
  try { return line ? JSON.parse(line) : { noJson: r.stdout + r.stderr }; } catch { return { noJson: r.stdout + r.stderr }; }
};

beforeAll(async () => {
  if (process.platform === 'win32') { skipAll = 'Windows is not supported by the Airlock sandbox in this release'; return; }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-conf-')));
  home = path.join(root, 'home');
  ws = path.join(root, 'ws');
  const tmp = path.join(root, 'tmp');
  const install = path.join(root, 'install');
  for (const d of [ws, tmp, install, path.join(ws, '.agenfk'), path.join(ws, 'sub', '.agenfk'), path.join(root, 'outside-agenfk'), path.join(ws, 'linked')]) fs.mkdirSync(d, { recursive: true });
  // A project .agenfk that is a symlink to a directory outside the workspace.
  fs.symlinkSync(path.join(root, 'outside-agenfk'), path.join(ws, 'linked', '.agenfk'));
  const plant = (rel: string, body = 'dummy-not-a-real-credential\n') => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  plant('.aws/credentials');
  plant('.ssh/id_ed25519');
  plant('.netrc');
  plant('.pi/agent/auth.json', '{}');
  plant('.agenfk/airlock-state.json', '{}');
  plant('.pi/agent/extensions/agenfk.ts', '// dummy');
  plant('.config/ok.txt', 'readable');
  for (const rel of ['.aws/sso/cache/token.json', '.git-credentials', '.pypirc', '.kube/config', '.config/gcloud/credentials.db', '.azure/msal_token_cache.json']) plant(rel);
  fs.writeFileSync(path.join(root, 'probe.cjs'), PROBE);

  check = await driver({ mode: 'check' });
  if (!check.supported || check.errors.length) {
    skipAll = `the Sandbox Runtime cannot sandbox here: ${check.supported ? check.errors.join('; ') : 'unsupported platform'}`;
    return;
  }
  pre = await driver({ mode: 'preflight', urls: [ZEN, GITHUB], lookup: ['example.com'] });

  const agenfkPort = await serve('agenfk-ok');
  const otherPort = await serve('other-service');
  const env = { ...process.env, HOME: home, FAKE_MODEL_KEY: FAKE_KEY };
  const node = process.execPath;
  const probe = path.join(root, 'probe.cjs');
  // The launcher's own enumeration, on the real file system: literal paths, as on Linux.
  const listDir = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isLink: e.isSymbolicLink() })); } catch { return null; } };
  const realpath = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const isDirectory = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const nested = findAgenfkDirs(ws, { listDir, realpath, isDirectory });
  const sessionFor = (over: object) => ({
    client: 'pi' as const, home, workspace: ws, tempDirs: [tmp], inferenceHosts: [] as string[],
    serverPort: agenfkPort, installDirs: [install], projectAgenfkDirs: nested.dirs, ...over,
  });
  const line = (spec: SandboxSpec, args: string[]) => sandboxCommandLine(spec, { file: node, args: [probe, ...args], cwd: ws });
  const runAll = async (spec: SandboxSpec, commands: Array<{ name: string; line: string; pty?: boolean }>) => {
    const out: Result[] = await driver({ mode: 'run', config: toAsrtConfig(spec), commands: commands.map((c) => ({ ...c, cwd: ws })) }, env);
    for (const r of out) results[r.name] = r;
  };

  // A: the plain launch shape: api.github.com allowed, the AgEnFK server on loopback.
  const ip = pre.addresses['example.com'];
  // A literal address allowed but inside a denied range: deny wins (review fix 1).
  const a = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: {
    allow: ['api.github.com', ...(ip ? [ip] : [])], deny: ip ? [`${ip.split('.').slice(0, 2).join('.')}.0.0/16`] : [],
  } }), sessionFor({}));
  // The runtime's binaries can all be present and the sandbox still unable to
  // start (no user namespaces, no /proc mount: Docker's default profile). The
  // launcher's own dry run decides, so these checks skip, with its reason,
  // where it would refuse (025f3000).
  await runAll(a, [{ name: 'start-probe', line: sandboxCommandLine(a, { ...sandboxNoop(), cwd: ws }) }]);
  if (results['start-probe'].code !== 0) {
    skipAll = sandboxStartFailure(results['start-probe'].stderr);
    return;
  }
  await runAll(a, [
    { name: 'fetch-allowed', line: line(a, ['fetch', ZEN]) },
    { name: 'fetch-unlisted', line: line(a, ['fetch', GITHUB]) },
    { name: 'curl-noproxy', line: `${sandboxCommandLine(a, { file: 'curl', args: ['-sS', '--max-time', '10', '--noproxy', '*', 'https://example.com/'], cwd: ws })}` },
    { name: 'socket-name', line: line(a, ['connect', 'example.com', '443']) },
    ...(ip ? [{ name: 'socket-ip', line: line(a, ['connect', ip, '443']) }] : []),
    ...(ip ? [{ name: 'denied-range-literal', line: line(a, ['fetch', `http://${ip}/`]) }] : []),
    { name: 'metadata-socket', line: line(a, ['connect', '169.254.169.254', '80']) },
    { name: 'metadata-proxy', line: line(a, ['fetch', 'http://169.254.169.254/latest/meta-data/']) },
    { name: 'server-loopback', line: line(a, ['fetch', `http://127.0.0.1:${agenfkPort}/`]) },
    { name: 'other-loopback', line: line(a, ['fetch', `http://127.0.0.1:${otherPort}/`]) },
    { name: 'other-loopback-socket', line: line(a, ['connect', '127.0.0.1', String(otherPort)]) },
    { name: 'read-aws', line: line(a, ['read', path.join(home, '.aws/credentials')]) },
    { name: 'read-ssh', line: line(a, ['read', path.join(home, '.ssh/id_ed25519')]) },
    { name: 'read-netrc', line: line(a, ['read', path.join(home, '.netrc')]) },
    { name: 'read-pi-auth', line: line(a, ['read', path.join(home, '.pi/agent/auth.json')]) },
    { name: 'read-control', line: line(a, ['read', path.join(home, '.config/ok.txt')]) },
    ...['.aws/sso/cache/token.json', '.git-credentials', '.pypirc', '.kube/config', '.config/gcloud/credentials.db', '.azure/msal_token_cache.json']
      .map((rel) => ({ name: `read-store:${rel}`, line: line(a, ['read', path.join(home, rel)]) })),
    { name: 'write-agenfk-state', line: line(a, ['write', path.join(home, '.agenfk/airlock-state.json')]) },
    { name: 'write-pi-extension', line: line(a, ['write', path.join(home, '.pi/agent/extensions/agenfk.ts')]) },
    { name: 'write-project-agenfk', line: line(a, ['write', path.join(ws, '.agenfk/db.sqlite')]) },
    { name: 'write-nested-agenfk', line: line(a, ['write', path.join(ws, 'sub/.agenfk/x')]) },
    { name: 'write-install', line: line(a, ['write', path.join(install, 'x.js')]) },
    { name: 'write-linked-agenfk', line: line(a, ['write', path.join(ws, 'linked', '.agenfk', 'db.sqlite')]) },
    { name: 'write-workspace', line: line(a, ['write', path.join(ws, 'out.txt')]) },
    { name: 'write-pi-state', line: line(a, ['write', path.join(home, '.pi/agent/sessions/s.jsonl')]) },
    { name: 'marker', line: line(a, ['env', 'AGENFK_AIRLOCK_SANDBOX']) },
    { name: 'gate-probe', line: line(a, ['gate', AIRLOCK_SCRIPT, home]) },
    ...(process.platform === 'darwin' && fs.existsSync('/usr/bin/script') ? [{ name: 'pty-raw', line: line(a, ['raw']), pty: true }] : []),
  ]);

  // B: the model key masked (TLS termination on), api.github.com standing in for the inference host.
  const b = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), sessionFor({ inferenceHosts: ['api.github.com'], maskedEnv: ['FAKE_MODEL_KEY'] }));
  await runAll(b, [
    { name: 'masked-key', line: line(b, ['env', 'FAKE_MODEL_KEY']) },
    { name: 'fetch-tls-terminated', line: line(b, ['fetch', ZEN]) },
  ]);

  // D: the masked key really arrives, injected by host name, at an HTTPS endpoint on its own port (review fix 5).
  const tls = tlsMaterial();
  if (tls) {
    const port = await serveTls(tls);
    const ca = path.join(root, 'ca-bundle.pem');
    const existing = process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS) ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') : '';
    fs.writeFileSync(ca, `${existing}\n${tls.cert}`);
    const d = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), sessionFor({ inferenceHosts: [`localhost:${port}`], maskedEnv: ['FAKE_MODEL_KEY'] }));
    const out: Result[] = await driver({ mode: 'run', config: toAsrtConfig(d), commands: [
      { name: 'inject-https-port', line: line(d, ['fetchauth', `https://localhost:${port}/`, 'FAKE_MODEL_KEY']), cwd: ws },
    ] }, { ...env, NODE_EXTRA_CA_CERTS: ca });
    for (const r of out) results[r.name] = r;
  }

  // R (SX-1, 8dd7c7c0): the sandbox reaches the server only through the launcher's
  // relay. Plain through the proxy, a CONNECT tunnel and SOCKS (the last two skip
  // ASRT's request filter, measured) all arrive marked; the server's own port is
  // not reachable at all.
  const echoPort = await new Promise<number>((resolve) => {
    const s = http.createServer((q, res) => { echoSeen.push(q.url ?? ''); res.end(JSON.stringify({ marker: q.headers['x-agenfk-airlock-session'] ?? null })); });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
  });
  relay = await startServerRelay({ target: `http://127.0.0.1:${echoPort}`, marker: () => RELAY_MARK, requireMarker: true });
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const rs = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce' }), sessionFor({ serverPort: relay.port, serverUrl: relayUrl }));
  const forged = ['-H', 'x-agenfk-airlock-session: forged'];
  const curl = (name: string, args: string[]) => ({ name, line: sandboxCommandLine(rs, { file: 'curl', args: ['-sS', '--max-time', '10', ...forged, ...args], cwd: ws }) });
  await runAll(rs, [
    { name: 'relay-fetch', line: line(rs, ['fetch', `${relayUrl}/items`]) },
    ...(has('curl') ? [
      curl('relay-curl-plain', [`${relayUrl}/items`]),
      curl('relay-curl-connect', ['-p', `${relayUrl}/items`]),
      { name: 'relay-curl-socks', line: sandboxCommandLine(rs, { file: '/bin/sh', args: ['-c', `curl -sS --max-time 10 -H 'x-agenfk-airlock-session: forged' --socks5-hostname "$(printf %s "$ALL_PROXY" | sed 's#.*://##')" ${relayUrl}/items`], cwd: ws }) },
    ] : []),
    { name: 'relay-server-direct', line: line(rs, ['fetch', `http://127.0.0.1:${echoPort}/items`]) },
    // SX-4: the board's header, however it travels, is refused before the server sees it
    ...(has('curl') ? [
      { name: 'board-plain', line: sandboxCommandLine(rs, { file: 'curl', args: ['-sS', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', 'x-agenfk-ui: 1', `${relayUrl}/airlock/policy`], cwd: ws }) },
      { name: 'board-connect', line: sandboxCommandLine(rs, { file: 'curl', args: ['-sS', '--max-time', '10', '-p', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', 'x-agenfk-ui: 1', `${relayUrl}/airlock/policy`], cwd: ws }) },
      { name: 'board-socks', line: sandboxCommandLine(rs, { file: '/bin/sh', args: ['-c', `curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X PUT -H 'x-agenfk-ui: 1' --socks5-hostname "$(printf %s "$ALL_PROXY" | sed 's#.*://##')" ${relayUrl}/airlock/policy`], cwd: ws }) },
    ] : []),
    { name: 'relay-api-url', line: line(rs, ['env', 'AGENFK_API_URL']) },
  ]);

  // X (SX-2, 8dd7c7c0): the sandbox for a COMMAND the server runs (agenfk airlock
  // exec): its own loopback works (test servers), the credentials, the report token
  // and AgEnFK's files stay out of reach, and so does an unlisted host.
  plant('.agenfk/airlock/report-token', 'dummy-report-token');
  const x = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['api.github.com'] } }), sessionFor({ purpose: 'command', serverPort: 0 }));
  const xline = (args: string[]) => sandboxCommandLine(x, { file: node, args: [probe, ...args], cwd: ws });
  await runAll(x, [
    { name: 'cmd-own-loopback', line: xline(['ownserver']) },
    { name: 'cmd-fetch-unlisted', line: xline(['fetch', GITHUB]) },
    { name: 'cmd-read-aws', line: xline(['read', path.join(home, '.aws/credentials')]) },
    { name: 'cmd-read-report-token', line: xline(['read', path.join(home, '.agenfk/airlock/report-token')]) },
    { name: 'cmd-write-agenfk', line: xline(['write', path.join(home, '.agenfk/x.json')]) },
    { name: 'cmd-write-workspace', line: xline(['write', path.join(ws, 'cmd-out.txt')]) },
    { name: 'cmd-host-loopback', line: xline(['fetch', `http://127.0.0.1:${agenfkPort}/`]) },
  ]);

  // C: github.com allowed, for git.
  const c = buildSandboxSpec(normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['github.com'], deny: [] } }), sessionFor({}));
  await runAll(c, [{
    name: 'git-ls-remote',
    line: sandboxCommandLine(c, { file: 'git', args: ['ls-remote', 'https://github.com/anthropics/sandbox-runtime', 'HEAD'], cwd: ws }),
  }]);
}, TIMEOUT);

afterAll(async () => {
  await relay?.close();
  for (const s of servers) s.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const has = (bin: string) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

describe('Airlock sandbox conformance (pinned Sandbox Runtime)', () => {
  it('runs the pinned version', (ctx) => {
    ctx.skip(!check, skipAll ?? 'the runtime was not checked');
    expect(check.version).toBe(ASRT_VERSION);
  });

  describe('network', () => {
    it('in-process fetch to an allowed host succeeds (NODE_USE_ENV_PROXY=1)', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!pre.answersOk?.[ZEN], 'api.github.com does not answer 200 to this machine even outside the sandbox (unreachable, or rate-limited)');
      expect(parse(results['fetch-allowed'])).toMatchObject({ status: 200 });
    });

    it('in-process fetch to an unlisted host fails', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!pre.reachable[GITHUB], 'github.com is not reachable outside the sandbox, so a failure here would prove nothing');
      const r = parse(results['fetch-unlisted']);
      expect(r.status ?? 0).not.toBe(200);
      expect(r.status === 403 || typeof r.error === 'string').toBe(true);
    });

    it('curl --noproxy to an unlisted host fails before TLS (no DNS, no route)', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!has('curl'), 'curl is not installed');
      // 6: could not resolve; 7: could not connect. A network-side reset would be 35/56.
      expect([6, 7]).toContain(results['curl-noproxy'].code);
    });

    it('a raw socket to an unlisted host fails, by name and by address', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['socket-name']).connected).toBeUndefined();
      expect(parse(results['socket-name']).error).toBeTruthy();
      if (results['socket-ip']) {
        expect(parse(results['socket-ip']).connected).toBeUndefined();
        if (process.platform === 'darwin') expect(parse(results['socket-ip']).error).toBe('EPERM');
      }
    });

    it('169.254.169.254 is unreachable, directly and through the proxy', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['metadata-socket']).connected).toBeUndefined();
      const viaProxy = parse(results['metadata-proxy']);
      expect(viaProxy.status === 403 || typeof viaProxy.error === 'string').toBe(true);
    });

    it('a literal address allowed but inside a denied range is unreachable (deny wins)', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!results['denied-range-literal'], 'example.com did not resolve outside the sandbox');
      const r = parse(results['denied-range-literal']);
      expect(r.proxyError || r.error, JSON.stringify(r)).toBeTruthy();
    });

    it('the AgEnFK server is reachable on its loopback port, and no other loopback port is', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['server-loopback'])).toMatchObject({ status: 200, body: 'agenfk-ok' });
      expect(parse(results['other-loopback']).body).not.toBe('other-service');
      expect(parse(results['other-loopback-socket']).connected).toBeUndefined();
    });

    it('the server is reached only through the relay, and every way there arrives marked (SX-1)', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['relay-api-url'])).toEqual({ value: `http://127.0.0.1:${relay!.port}` });
      expect(parse(results['relay-fetch'])).toMatchObject({ status: 200, body: JSON.stringify({ marker: RELAY_MARK }) });
      for (const name of ['relay-curl-plain', 'relay-curl-connect', 'relay-curl-socks']) {
        if (!results[name]) continue;
        expect(JSON.parse(results[name].stdout || '{}'), `${name}: ${results[name].stderr}`).toEqual({ marker: RELAY_MARK });
      }
      // the server's own port: not on the allow list
      expect(parse(results['relay-server-direct']).status).not.toBe(200);
    });

    it('a board-only write from the sandbox is refused however it travels: plain, CONNECT, SOCKS (SX-4)', (ctx) => {
      ctx.skip(!!skipAll || !results['board-plain'], skipAll ?? 'curl is not installed');
      for (const name of ['board-plain', 'board-connect', 'board-socks']) {
        expect(results[name].stdout.trim(), `${name}: ${results[name].stderr}`).toBe('403');
      }
      expect(echoSeen.filter((u) => u.includes('/airlock/policy'))).toEqual([]);
    });

    it('a command the server runs: its own loopback works; credentials, the report token, AgEnFK files and unlisted hosts do not (SX-2)', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['cmd-own-loopback'])).toEqual({ body: 'own' });
      const unlisted = parse(results['cmd-fetch-unlisted']);
      expect(unlisted.status === 200 && !unlisted.proxyError, JSON.stringify(unlisted)).toBe(false);
      expect(parse(results['cmd-read-aws']).error).toBeTruthy();
      expect(parse(results['cmd-read-report-token']).error).toBeTruthy();
      expect(parse(results['cmd-write-agenfk']).error).toBeTruthy();
      expect(parse(results['cmd-write-workspace'])).toEqual({ wrote: true });
      // the host's own loopback: unreachable on Linux (a network namespace); reachable on macOS, the documented limit
      if (process.platform === 'linux') expect(parse(results['cmd-host-loopback']).body).not.toBe('agenfk-ok');
    });

    it('git ls-remote to an allowed host works', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!has('git'), 'git is not installed');
      ctx.skip(!pre.reachable[GITHUB], 'github.com is not reachable from this machine even outside the sandbox');
      const r = results['git-ls-remote'];
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^[0-9a-f]{40}\s+HEAD/m);
    });
  });

  describe('files', () => {
    it('the credential stores cannot be read; an ordinary file can', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      for (const name of ['read-aws', 'read-ssh', 'read-netrc', 'read-pi-auth']) {
        expect(parse(results[name]), name).toMatchObject({ error: expect.stringMatching(/EPERM|EACCES|ENOENT/) });
      }
      for (const name of Object.keys(results).filter((n) => n.startsWith('read-store:'))) {
        expect(parse(results[name]), name).toMatchObject({ error: expect.stringMatching(/EPERM|EACCES|ENOENT/) });
      }
      expect(Object.keys(results).filter((n) => n.startsWith('read-store:'))).toHaveLength(6);
      expect(parse(results['read-control'])).toMatchObject({ read: 8 });
    });

    it('AgEnFK control paths cannot be written; the workspace and the client state can', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      for (const name of ['write-agenfk-state', 'write-pi-extension', 'write-project-agenfk', 'write-nested-agenfk', 'write-install', 'write-linked-agenfk']) {
        expect(parse(results[name]), name).toMatchObject({ error: expect.stringMatching(/EPERM|EACCES|EROFS/) });
      }
      expect(fs.readFileSync(path.join(home, '.agenfk/airlock-state.json'), 'utf8')).toBe('{}');
      expect(parse(results['write-workspace'])).toMatchObject({ wrote: true });
      expect(parse(results['write-pi-state'])).toMatchObject({ wrote: true });
    });
  });

  describe('the session', () => {
    it('carries the marker, and the launch gate sees it as sandboxed', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      expect(parse(results['marker'])).toEqual({ value: 'pi' });
      // marker + proxy env + ~/.agenfk unwritable + a direct connection refused by the sandbox
      expect(parse(results['gate-probe'])).toEqual({ sandboxed: true });
    });

    it('the model key is masked: the sandbox sees a stand-in, never the real value', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      const v = parse(results['masked-key']).value;
      expect(v).toBeTruthy();
      expect(v).not.toBe(FAKE_KEY);
      expect(results['masked-key'].stdout).not.toContain(FAKE_KEY);
    });

    it('the masked key arrives, injected, at an HTTPS inference endpoint on its own port', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!results['inject-https-port'], 'openssl is not installed, so no local HTTPS endpoint could be made');
      expect(parse(results['inject-https-port']), results['inject-https-port'].stderr).toMatchObject({ status: 200, body: 'real' });
      expect(injectSeen).toBe('real');
    });

    it('with TLS termination on (masking), an allowed host still verifies', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!pre.answersOk?.[ZEN], 'api.github.com does not answer 200 to this machine even outside the sandbox (unreachable, or rate-limited)');
      expect(parse(results['fetch-tls-terminated'])).toMatchObject({ status: 200 });
    });

    it('a TUI can put its terminal in raw mode', (ctx) => {
      ctx.skip(!!skipAll, skipAll ?? '');
      ctx.skip(!results['pty-raw'], 'the pseudo-terminal check runs on macOS (it uses /usr/bin/script)');
      expect(parse(results['pty-raw'])).toEqual({ raw: true });
    });
  });
});
