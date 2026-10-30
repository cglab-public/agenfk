/**
 * @vitest-environment node
 *
 * ea94c023 (Airlock): the exec helper the desktop app ships. The packaged app
 * has no CLI beside its server, and its Node is Electron; for a card an Airlock
 * sandbox touched, the server runs this helper (ELECTRON_RUN_AS_NODE=1) to run
 * the card's commands in the sandbox. Like serverBundle.test.ts, it is run from
 * a directory with no node_modules above it, as it would be inside the .app.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '../..');
const built = path.join(desktopDir, 'build', 'airlock');
const builtSmolvm = path.join(desktopDir, 'build', 'airlock-smolvm');
/** electron-builder's ${os}. */
const BUILDER_OS: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' };
/** The smolvm release the CLI pins (packages/cli/src/airlock/smolvm.ts), read from its source. */
const SMOLVM_VERSION = /export const SMOLVM_VERSION = '([^']+)'/.exec(fs.readFileSync(path.resolve(desktopDir, '../cli/src/airlock/smolvm.ts'), 'utf8'))![1];
const smolvmPlatform = ['darwin-arm64', 'linux-arm64', 'linux-x64'].includes(`${process.platform}-${process.arch}`);
/**
 * Running the helper for real starts a smolvm machine: only with AGENFK_SMOLVM_TESTS=1, and an
 * image the machine can pull (AGENFK_AIRLOCK_TEST_IMAGE_REF, util-linux in it) whose registry
 * hosts are in AGENFK_AIRLOCK_TEST_REGISTRY_HOSTS (comma-separated).
 */
const realRun = process.env.AGENFK_SMOLVM_TESTS === '1' && !!process.env.AGENFK_AIRLOCK_TEST_IMAGE_REF;

let isolated: string;
let policy: http.Server;
let policyUrl: string;

beforeAll(async () => {
  execFileSync('node', [path.join(desktopDir, 'scripts', 'bundle-airlock.mjs')], { cwd: desktopDir, stdio: 'pipe' });
  isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-isolated-')));
  fs.cpSync(built, path.join(isolated, 'airlock'), { recursive: true });
  // As electron-builder lays it out: this architecture's smolvm under airlock/smolvm.
  const mine = path.join(builtSmolvm, `${BUILDER_OS[process.platform]}-${process.arch}`);
  if (fs.existsSync(mine)) fs.cpSync(mine, path.join(isolated, 'airlock', 'smolvm'), { recursive: true });
  // A stand-in for the server: the whole effective policy, as GET /airlock/policy serves it.
  const { normalizeAirlockPolicy } = await import('@agenfk/core');
  const effective = normalizeAirlockPolicy({
    mode: 'enforce',
    ...(process.env.AGENFK_AIRLOCK_TEST_IMAGE_REF ? { machineImage: process.env.AGENFK_AIRLOCK_TEST_IMAGE_REF } : {}),
    hosts: { allow: (process.env.AGENFK_AIRLOCK_TEST_REGISTRY_HOSTS ?? '').split(',').filter(Boolean), deny: [] },
  });
  policy = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ effective, source: 'local', revision: 1, capabilities: ['sandboxed-commands', 'machine-image'] })); });
  await new Promise<void>((r) => policy.listen(0, '127.0.0.1', () => r()));
  policyUrl = `http://127.0.0.1:${(policy.address() as any).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => policy?.close(r));
  if (isolated) fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the bundled Airlock exec helper', () => {
  it('is produced by the packaging script: one module, its egress decider beside it, the pinned smolvm with them (CGLAB-696)', () => {
    expect(fs.existsSync(path.join(built, 'dist', 'agenfk-airlock-exec.mjs'))).toBe(true);
    // startEgressHelper runs egressMain.js from the helper's own directory.
    expect(fs.existsSync(path.join(built, 'dist', 'egressMain.js'))).toBe(true);
    // electron-builder leaves node_modules out of a resource: nothing may depend on one
    expect(fs.existsSync(path.join(built, 'node_modules'))).toBe(false);
    // The Sandbox Runtime is gone, its vendored helpers with it.
    expect(fs.existsSync(path.join(built, 'vendor'))).toBe(false);
    expect(fs.existsSync(path.join(built, 'sandbox-runtime.json'))).toBe(false);
  });

  it.skipIf(!smolvmPlatform)('bundles exactly the pinned smolvm for this platform, runnable from where the app keeps it', () => {
    const dir = path.join(builtSmolvm, `${BUILDER_OS[process.platform]}-${process.arch}`);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'smolvm.json'), 'utf8'))).toEqual({ name: 'smolvm', version: SMOLVM_VERSION, platform: `${process.platform}-${process.arch}` });
    // Where the packaged app has it (extraResources below), beside the helper's dist/.
    const v = spawnSync(path.join(isolated, 'airlock', 'smolvm', 'smolvm'), ['--version'], { encoding: 'utf8' });
    expect(v.stdout.trim()).toBe(`smolvm ${SMOLVM_VERSION}`);
  });

  // review 01a18d3a: one bundle feeds every architecture electron-builder packages for this OS.
  it('gives each artifact the smolvm of its own architecture: one directory per OS-arch, picked by electron-builder', async () => {
    const config = (await import(path.join(desktopDir, 'electron-builder.config.cjs'))).default;
    expect(config.extraResources).toContainEqual({ from: 'build/airlock-smolvm/${os}-${arch}', to: 'packages/airlock/smolvm' });
    const os = BUILDER_OS[process.platform];
    const targetKey = os === 'mac' ? 'mac' : os === 'win' ? 'win' : 'linux';
    const arches = new Set<string>(config[targetKey].target.flatMap((t: { arch: string[] }) => t.arch));
    for (const arch of arches) {
      // Every one exists, so packaging never fails on a missing source: empty where smolvm does not run.
      expect(fs.statSync(path.join(builtSmolvm, `${os}-${arch}`)).isDirectory(), `${os}-${arch}`).toBe(true);
      const json = path.join(builtSmolvm, `${os}-${arch}`, 'smolvm.json');
      if (fs.existsSync(json)) expect(JSON.parse(fs.readFileSync(json, 'utf8')).platform, `${os}-${arch}`).toBe(`${process.platform}-${arch}`);
    }
    if (os === 'linux') for (const arch of ['x64', 'arm64']) expect(fs.existsSync(path.join(builtSmolvm, `linux-${arch}`, 'smolvm')), arch).toBe(true);
  });

  it('ships the licence notices of everything it inlines and bundles (review, Codex 01a182bc)', () => {
    const notices = fs.readFileSync(path.join(built, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    // zod came with the Sandbox Runtime, and went with it.
    for (const dep of ['node-forge', 'commander', 'axios']) expect(notices, dep).toContain(`${dep}@`);
    expect(notices).not.toContain('@anthropic-ai/sandbox-runtime');
    if (smolvmPlatform) expect(notices).toContain(`smolvm@${SMOLVM_VERSION}  (Apache-2.0)`);
    expect(notices).toMatch(/Digital Bazaar/);
    expect(notices).toMatch(/Permission is hereby granted/);
  });

  it('carries everything it needs instead of requiring it', () => {
    for (const file of ['agenfk-airlock-exec.mjs', 'egressMain.js']) {
      const source = fs.readFileSync(path.join(built, 'dist', file), 'utf8');
      for (const dep of ['commander', 'axios', 'chalk', '@agenfk/core', 'zod', 'node-forge']) {
        expect(source.includes(`require("${dep}")`) || source.includes(`from "${dep}"`), `${file}: ${dep}`).toBe(false);
      }
    }
  });
});

describe.skipIf(!realRun)('the bundled helper, run where the app would run it (AGENFK_SMOLVM_TESTS=1)', () => {
  // Not spawnSync: the stand-in policy server answers from this very process.
  const run = (launcher: string, extraEnv: NodeJS.ProcessEnv, command = 'echo marker=$AGENFK_AIRLOCK_SANDBOX') => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const ws = fs.mkdtempSync(path.join(isolated, 'ws-'));
    const child = spawn(launcher, [path.join(isolated, 'airlock', 'dist', 'agenfk-airlock-exec.mjs'), 'airlock', 'exec', '--no-process-group', '--cwd', ws, '--', command], {
      cwd: isolated,
      // The user's real HOME: smolvm keeps its sockets under it, and a vitest worker's sandbox HOME is past the 103-byte limit.
      env: { PATH: process.env.PATH, HOME: os.userInfo().homedir, TMPDIR: process.env.TMPDIR, AGENFK_API_URL: policyUrl, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });

  it('runs a command in the sandbox with Node', async (ctx) => {
    const r = await run(process.execPath, {});
    if (r.status === 125 && /could not start|cannot sandbox|does not support|cannot run here/i.test(r.stderr)) ctx.skip();
    expect(r.stdout, r.stderr).toContain('marker=command');
    expect(r.status).toBe(0);
  }, 300_000);

  it('runs it with Electron as Node, as the desktop server does', async (ctx) => {
    let electron: string | null = null;
    try { electron = require(path.join(desktopDir, 'node_modules', 'electron')) as unknown as string; } catch { /* hoisted */ }
    if (!electron) try { electron = require('electron') as unknown as string; } catch { electron = null; }
    if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) return ctx.skip();
    const r = await run(electron, { ELECTRON_RUN_AS_NODE: '1' });
    if (r.status === 125 && /could not start|cannot sandbox|does not support|cannot run here/i.test(r.stderr)) ctx.skip();
    expect(r.stdout, r.stderr).toContain('marker=command');
    expect(r.status).toBe(0);
  }, 300_000);

  // review (Codex 01a182bc): the boundaries, from inside, not just the marker
  it('inside: the helper\'s own files are unwritable, ELECTRON_RUN_AS_NODE is gone, and a host Unix socket is out of reach', async (ctx) => {
    let electron: string | null = null;
    try { electron = require('electron') as unknown as string; } catch { electron = null; }
    const launcher = electron && typeof electron === 'string' && fs.existsSync(electron) ? electron : process.execPath;
    const sock = path.join(os.tmpdir(), `agenfk-airlock-sock-${process.pid}.sock`);
    fs.rmSync(sock, { force: true });
    const server = require('net').createServer((c: any) => c.end('host-socket')).listen(sock);
    await new Promise((r) => server.once('listening', r));
    try {
      const helperFile = path.join(isolated, 'airlock', 'dist', 'agenfk-airlock-exec.mjs');
      const probeFile = path.join(isolated, 'probe.cjs');
      fs.writeFileSync(probeFile, [
        "const fs = require('fs'); const net = require('net'); const [helper, vendorFile, sockPath] = process.argv.slice(2); const out = {};",
        "try { fs.appendFileSync(helper, 'x'); out.helper = 'WROTE'; } catch (e) { out.helper = e.code; }",
        "try { fs.writeFileSync(vendorFile, 'x'); out.vendor = 'WROTE'; } catch (e) { out.vendor = e.code; }",
        "out.runAsNode = process.env.ELECTRON_RUN_AS_NODE ?? null;",
        "const fin = () => { console.log('PROBE ' + JSON.stringify(out)); process.exit(0); };",
        "const c = net.connect(sockPath); c.on('data', (d) => { out.sock = String(d); fin(); }); c.on('error', (e) => { out.sock = e.code; fin(); });",
        "setTimeout(() => { out.sock = out.sock ?? 'TIMEOUT'; fin(); }, 5000);",
      ].join('\n'));
      const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
      const probe = ['node', probeFile, helperFile, path.join(isolated, 'airlock', 'smolvm', 'x'), sock].map(q).join(' ');
      const r = await run(launcher, launcher === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: '1' }, probe);
      if (r.status === 125 && /could not start|cannot sandbox|does not support|cannot run here/i.test(r.stderr)) return ctx.skip();
      const line = r.stdout.split('\n').find((l) => l.startsWith('PROBE '));
      expect(line, r.stdout + r.stderr).toBeTruthy();
      const out = JSON.parse(line!.slice(6));
      expect(out.helper).not.toBe('WROTE');
      expect(out.vendor).not.toBe('WROTE');
      expect(out.runAsNode).toBeNull();
      expect(out.sock).not.toBe('host-socket');
    } finally {
      server.close();
      fs.rmSync(sock, { force: true });
    }
  }, 300_000);
});
