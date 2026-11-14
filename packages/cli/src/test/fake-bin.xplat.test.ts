/**
 * @file GitHub #208 phase 3 — the offline PATH the installer specs run under.
 *
 * The installer specs (installer-channel-tags, install-prunes-against-tarball,
 * bootstrap-prunes-install-dir, self-extract-prune) run the real bootstrap with
 * a PATH holding ONLY what it legitimately needs: node, the real tar (and git
 * where packages/create insists on it), and stub curl/gh/npm that answer from
 * a table instead of the network. They built it by symlinking `node` and the
 * tools `sh -c 'command -v X'` found, and by writing `#!/bin/sh` stubs - none
 * of which works on Windows: a symlink needs admin there (EPERM), there is no
 * /bin/sh, and the product's `execSync` runs commands through cmd.exe, which
 * finds them by PATH + PATHEXT, never by a shebang.
 *
 * `fakeBin` builds that PATH on every OS: symlinks exactly as before off
 * Windows; on it, a real node.exe and tar.exe in the directory and `.cmd`
 * launchers for the stubs. Whatever it builds must be runnable the two ways the
 * product runs things - through a shell (`execSync`) and directly
 * (`spawnSync` with no shell, as packages/create checks for git and
 * scripts/install.mjs runs tar) - and must hold nothing it was not asked for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fakeBin, hostTar } from './helpers/fakeBin';

let work = '';
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); work = ''; });
const tmp = () => (work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fakebin-')));

const sh = (cmd: string, env: NodeJS.ProcessEnv, cwd?: string) =>
  execSync(cmd, { encoding: 'utf8', env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

describe('fakeBin(): node', () => {
  it('is the running node, through a shell', () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { node: true });
    expect(sh('node -e "process.stdout.write(process.version)"', b.env())).toBe(process.version);
  });

  it('is one cached node.exe per node version on Windows, hard-linked into every bin and never copied per run', () => {
    // A copy per spec file was ~93 MB each, and nothing removed it: dozens of
    // them piled up in %TEMP%. Off Windows node is a symlink, as it always was.
    const a = fakeBin(path.join(tmp(), 'a'), { node: true });
    const b = fakeBin(path.join(work, 'b'), { node: true });
    if (process.platform !== 'win32') {
      expect(fs.readlinkSync(path.join(a.dir, 'node'))).toBe(process.execPath);
      return;
    }
    const cache = path.join(os.tmpdir(), `agenfk-fakebin-node-${process.version}-${process.arch}`, 'node.exe');
    const ino = fs.statSync(cache, { bigint: true }).ino;
    expect(fs.statSync(path.join(a.dir, 'node.exe'), { bigint: true }).ino).toBe(ino);
    expect(fs.statSync(path.join(b.dir, 'node.exe'), { bigint: true }).ino).toBe(ino);
    expect(fs.readdirSync(path.dirname(cache))).toEqual(['node.exe']);
  });

  it.runIf(process.platform === 'win32')('sweeps a half-written copy a killed worker left in the cache', () => {
    // Windows only: off Windows there is no cache, node is a symlink.
    fakeBin(path.join(tmp(), 'a'), { node: true });
    const cacheDir = path.join(os.tmpdir(), `agenfk-fakebin-node-${process.version}-${process.arch}`);
    const stale = path.join(cacheDir, 'node.exe.99999.0.partial');
    fs.writeFileSync(stale, 'half a node');

    fakeBin(path.join(work, 'b'), { node: true });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(cacheDir)).toEqual(['node.exe']);
  });

  it('is the running node, spawned with no shell', () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { node: true });
    const r = spawnSync('node', ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8', env: b.env(), windowsHide: true });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe(process.version);
  });
});

describe('fakeBin(): tar', () => {
  /** An archive made the way the specs make theirs: hostTar() over a staged tree. */
  function archive(dir: string): string {
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'commands', 'agenfk.md'), 'current\n');
    const tarball = path.join(dir, 'dist.tar.gz');
    const made = spawnSync(hostTar(), ['-czf', tarball, '-C', stage, 'commands'], { encoding: 'utf8', windowsHide: true });
    expect(made.status, made.stderr).toBe(0);
    return tarball;
  }

  it('extracts a gzipped archive by absolute path through a shell, as self-extract runs it', () => {
    const dir = tmp();
    const tarball = archive(dir);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const b = fakeBin(path.join(dir, 'bin'), { tools: ['tar', 'gzip'] });

    sh(`tar -xzf "${tarball}" -C "${out}"`, b.env());

    expect(fs.readFileSync(path.join(out, 'commands', 'agenfk.md'), 'utf8')).toBe('current\n');
  });

  it('lists an archive spawned with no shell, as scripts/install.mjs runs it', () => {
    const dir = tmp();
    const tarball = archive(dir);
    const b = fakeBin(path.join(dir, 'bin'), { tools: ['tar', 'gzip'] });

    const r = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', env: b.env(), windowsHide: true });

    expect(r.error).toBeUndefined();
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toContain('commands/agenfk.md');
  });
});

describe('fakeBin(): git', () => {
  it('answers --version spawned with no shell, as packages/create checks for it', () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { tools: ['git'] });
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', env: b.env(), windowsHide: true });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
  });
});

describe('fakeBin(): stubs', () => {
  const ECHO = `
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
if (args.includes('-o')) require('fs').writeFileSync(out, JSON.stringify(args));
else process.stdout.write(JSON.stringify(args));
if (args.includes('--fail')) process.exit(22);
`;

  it('runs a stub through a shell with every argument intact, quotes and spaces included', () => {
    const dir = tmp();
    const b = fakeBin(path.join(dir, 'bin'), { stubs: { curl: ECHO } });
    const url = 'https://api.github.com/repos/o/r/releases?per_page=100';

    const out = sh(`curl -fsSL "${url}" -H "Accept: application/vnd.github+json" --template '{{.tagName}}'`, b.env());

    // '{{.tagName}}' arrives with its quotes under cmd.exe and without them
    // under sh: that is the shell's doing, and the product's to live with.
    const args = JSON.parse(out);
    expect(args.slice(0, 5)).toEqual(['-fsSL', url, '-H', 'Accept: application/vnd.github+json', '--template']);
    expect(args[5].replace(/^'|'$/g, '')).toBe('{{.tagName}}');
  });

  it('writes to an -o path with spaces in it, the way the bootstrap downloads', () => {
    const dir = tmp();
    const b = fakeBin(path.join(dir, 'bin'), { stubs: { curl: ECHO } });
    const target = path.join(dir, 'with space', 'agenfk-dist.tar.gz');
    fs.mkdirSync(path.dirname(target));

    sh(`curl -fsSL "https://example.invalid/x" -o "${target}"`, b.env());

    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(['-fsSL', 'https://example.invalid/x', '-o', target]);
  });

  it("passes the stub's exit status back to the caller", () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { stubs: { curl: ECHO } });
    let status: number | null = null;
    try { sh('curl --fail', b.env()); } catch (e) { status = (e as { status: number | null }).status; }
    expect(status).toBe(22);
  });

  it('runs in the caller\'s working directory', () => {
    const dir = tmp();
    const cwd = path.join(dir, 'root');
    fs.mkdirSync(cwd);
    const b = fakeBin(path.join(dir, 'bin'), { stubs: { npm: `require('fs').writeFileSync('.npm-was-called', process.argv.slice(2).join(' '));` } });

    // self-extract runs `npm.cmd ci ...` on win32 and `npm ci ...` elsewhere.
    sh(`${process.platform === 'win32' ? 'npm.cmd' : 'npm'} ci --omit=dev`, b.env(), cwd);

    expect(fs.readFileSync(path.join(cwd, '.npm-was-called'), 'utf8')).toBe('ci --omit=dev');
  });
});

describe('fakeBin(): offline by construction', () => {
  it('holds no tool it was not asked for', () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { node: true });
    for (const tool of ['curl', 'gh', 'tar']) {
      let ran = true;
      try { sh(`${tool} --version`, b.env()); } catch { ran = false; }
      expect(ran, `${tool} is reachable on the fake PATH`).toBe(false);
    }
  });

  it('puts the extra variables a spec passes into the env it hands back, and PATH last', () => {
    const b = fakeBin(path.join(tmp(), 'bin'), { node: true });
    const env = b.env({ HOME: '/h', NODE_ENV: 'production', PATH: '/should/not/win' });
    expect(env.HOME).toBe('/h');
    expect(env.NODE_ENV).toBe('production');
    expect(env.PATH!.split(path.delimiter)[0]).toBe(b.dir);
  });
});
