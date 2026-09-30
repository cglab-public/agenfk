/**
 * e04dac92 (CGLAB-164): `agenfk up` ends in one line, and the CLI prints no
 * ASCII banner.
 *
 * scripts/start-services.mjs used to print seven lines (requested port, board,
 * "started in background", API URL, database path, logs, board URL again). It
 * now prints one: the board's address and where the logs are.
 *
 * The figlet banner printed on every command run from an interactive terminal;
 * it is gone. That needs a real TTY to see, so the CLI is run under script(1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const nonEmpty = (s: string) => strip(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** An install dir holding the real service script and a stand-in server that reports its port. */
function fakeInstall(opts: { withBoard: boolean; requestedPort?: string; serverReports?: boolean }) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-services-'));
  const root = path.join(work, 'agenfk-system');
  const home = path.join(work, 'home');
  mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'scripts', 'start-services.mjs'), path.join(root, 'scripts', 'start-services.mjs'));
  mkdirSync(path.join(root, 'packages', 'server', 'dist'), { recursive: true });
  writeFileSync(
    path.join(root, 'packages', 'server', 'dist', 'server.js'),
    opts.serverReports === false
      ? 'setTimeout(() => {}, 1);\n' // starts, never reports a port
      : "require('fs').writeFileSync(require('path').join(process.env.HOME, '.agenfk', 'server-port'), '4321');\n",
    'utf8',
  );
  if (opts.withBoard) {
    mkdirSync(path.join(root, 'packages', 'ui', 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'ui', 'dist', 'index.html'), '<!doctype html>', 'utf8');
  }
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'start-services.mjs')], {
    encoding: 'utf8',
    timeout: 40_000,
    cwd: root,
    env: { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath), AGENFK_NO_OPEN_BROWSER: '1', AGENFK_PORT: opts.requestedPort ?? '4321', VITEST: '1' },
  });
  return { work, run };
}

describe('start-services.mjs prints one line', () => {
  let s: ReturnType<typeof fakeInstall>;
  beforeAll(() => { s = fakeInstall({ withBoard: true }); });
  afterAll(() => rmSync(s.work, { recursive: true, force: true }));

  it('names the board at the port the server bound, and where the logs are', () => {
    expect(s.run.status).toBe(0);
    const out = nonEmpty(`${s.run.stdout}${s.run.stderr}`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^✓ AgEnFK running - board at http:\/\/localhost:4321 \(logs: .+\.agenfk\)$/);
  });
});

describe('start-services.mjs without a built board', () => {
  let s: ReturnType<typeof fakeInstall>;
  beforeAll(() => { s = fakeInstall({ withBoard: false }); });
  afterAll(() => rmSync(s.work, { recursive: true, force: true }));

  it('says the API is running and warns that there is no board', () => {
    expect(s.run.status).toBe(0);
    const out = nonEmpty(`${s.run.stdout}${s.run.stderr}`);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^✓ AgEnFK running - API at http:\/\/localhost:4321/);
    expect(out[1]).toMatch(/^⚠ No built board/);
  });
});

describe('start-services.mjs when the requested port was taken', () => {
  let s: ReturnType<typeof fakeInstall>;
  beforeAll(() => { s = fakeInstall({ withBoard: true, requestedPort: '3000' }); });
  afterAll(() => rmSync(s.work, { recursive: true, force: true }));

  it('names the port the server really took, and warns that it moved', () => {
    const out = nonEmpty(`${s.run.stdout}${s.run.stderr}`);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/board at http:\/\/localhost:4321 /);
    expect(out[1]).toMatch(/^⚠ Port 3000 was unavailable, so the server took 4321$/);
  });
});

describe('start-services.mjs when the server never reports its port', () => {
  let s: ReturnType<typeof fakeInstall>;
  beforeAll(() => { s = fakeInstall({ withBoard: true, serverReports: false }); }, 40_000);
  afterAll(() => rmSync(s.work, { recursive: true, force: true }));

  it('does not claim it is running - it warns and points at the log', () => {
    const out = nonEmpty(`${s.run.stdout}${s.run.stderr}`);
    expect(out.some((l) => l.startsWith('✓'))).toBe(false);
    expect(out[0]).toMatch(/^⚠ The AgEnFK server started but has not reported its port yet - see .+api\.log$/);
  });
});

describe('the CLI prints no ASCII banner, even at an interactive terminal', () => {
  const bin = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
  let tty: ReturnType<typeof spawnSync> | null = null;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'agenfk-banner-'));
    if (!existsSync(bin) || process.platform === 'win32') return;
    // script(1) gives the child a pseudo-terminal, so process.stdout.isTTY is true there.
    const args = process.platform === 'darwin'
      ? ['-q', '/dev/null', process.execPath, bin, '-V']
      : ['-qec', `"${process.execPath}" "${bin}" -V`, '/dev/null'];
    tty = spawnSync('script', args, {
      encoding: 'utf8',
      timeout: 30_000,
      // Not 'pipe': script(1) cannot take terminal settings from a socket and exits 1.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'production' },
    });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('prints just the version for `agenfk -V`', () => {
    if (!tty) return; // no built CLI here (CI builds before testing)
    expect(tty.status).toBe(0);
    const out = nonEmpty(String(tty.stdout));
    expect(out).toHaveLength(1);
    // macOS script(1) echoes the closed stdin as `^D` ahead of the output.
    expect(out[0]).toMatch(/(^|\^D[\b]*)\d+\.\d+\.\d+\S*$/);
  });
});
