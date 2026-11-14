import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

/**
 * An offline PATH for the installer specs (GitHub #208 phase 3).
 *
 * The specs run the real bootstrap (bin/agenfk.js, packages/create, the hub's
 * self-extract) with a PATH holding only what it legitimately needs: node, the
 * real tar, git where packages/create insists on it, and stub curl/gh/npm that
 * answer from a table instead of the network. They used to build it by
 * symlinking node and whatever `sh -c 'command -v X'` found, with `#!/bin/sh`
 * stubs. None of that works on Windows: a symlink needs admin there (EPERM),
 * and the product's execSync runs commands through cmd.exe, which finds them by
 * PATH + PATHEXT and never reads a shebang.
 *
 * Off Windows the tools are symlinked exactly as before. On Windows:
 *   - node is node.exe itself, hard-linked from a copy made once per process
 *     (a hard link straight to Program Files needs write access to it);
 *   - tar is the tar Windows ships (System32\tar.exe, bsdtar), which is what
 *     cmd and PowerShell find - and so what the product meets on a user's
 *     machine. bsdtar gunzips by itself, so gzip needs nothing;
 *   - git is Git for Windows' cmd\ directory, appended to PATH: its git.exe
 *     cannot run from a copy, and that directory carries git and nothing else
 *     (no curl, tar or gh), so the PATH stays offline.
 * The stubs are one JavaScript body on every OS, behind a launcher that runs it
 * with this node by absolute path: a tiny sh script off Windows, a `.cmd` on it.
 */
export interface FakeBinOptions {
  /** node on PATH as `node`. */
  node?: boolean;
  /** Real tools by name: tar, gzip and git anywhere; anything `command -v` finds off Windows. */
  tools?: string[];
  /** name -> CommonJS source of a stub. It reads its arguments from process.argv.slice(2). */
  stubs?: Record<string, string>;
}

export interface FakeBin {
  dir: string;
  /** An env whose PATH is this bin (and nothing else that carries a tool), with the caller's variables. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

const isWin = process.platform === 'win32';
const systemRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';

/** The tar a spec builds its own archives with: the one the fake PATH carries on Windows. */
export function hostTar(): string {
  return isWin ? path.win32.join(systemRoot(), 'System32', 'tar.exe') : 'tar';
}

let nodeCache: string | undefined;

/**
 * Remove `*.partial` copies left by a worker killed mid-copy - only once
 * node.exe is in place, so no worker still needs one. Safe even if a live
 * worker is still copying: Windows will not delete a file open for writing
 * (the error is swallowed), and if the delete does land, that worker's rename
 * fails and its fallback drops its copy and uses the node.exe already there.
 */
function sweepPartials(dir: string): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.endsWith('.partial')) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* being written: left to its worker */ }
    }
  }
}
/**
 * One copy of node.exe per node version and arch, in the temp dir, reused by
 * every run and every worker and never deleted: a copy per spec file (~93 MB)
 * was never cleaned up from a vitest worker and piled up in %TEMP%. It is
 * written under a unique name and renamed into place, so parallel workers
 * racing to create it never see a half-written file; the loser drops its copy.
 */
function cachedNode(): string {
  if (nodeCache) { sweepPartials(path.dirname(nodeCache)); return nodeCache; }
  const dir = path.join(os.tmpdir(), `agenfk-fakebin-node-${process.version}-${process.arch}`);
  const target = path.join(dir, 'node.exe');
  if (fs.existsSync(target)) sweepPartials(dir);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(dir, { recursive: true });
    const partial = path.join(dir, `node.exe.${process.pid}.${Date.now()}.partial`);
    fs.copyFileSync(process.execPath, partial);
    try {
      fs.renameSync(partial, target);
    } catch {
      // Another worker put it in place first (and may be running it).
      fs.rmSync(partial, { force: true });
      if (!fs.existsSync(target)) throw new Error(`fakeBin: could not cache node.exe at ${target}`);
    }
  }
  return (nodeCache = target);
}

let gitCmd: string | undefined;
/** Git for Windows' cmd\ directory, found from git itself rather than assumed. */
function gitCmdDir(): string {
  if (gitCmd) return gitCmd;
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
  // <git root>\<mingw64|ucrt64|...>\libexec\git-core
  const dir = path.win32.resolve(execPath, '..', '..', '..', 'cmd');
  if (!fs.existsSync(path.win32.join(dir, 'git.exe'))) {
    throw new Error(`Git for Windows has no cmd\\git.exe at ${dir}; the installer specs need it`);
  }
  return (gitCmd = dir);
}

const shQuote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

export function fakeBin(dir: string, opts: FakeBinOptions = {}): FakeBin {
  fs.mkdirSync(dir, { recursive: true });
  const extraPath: string[] = [];

  if (opts.node) {
    if (isWin) {
      const target = path.join(dir, 'node.exe');
      try { fs.linkSync(cachedNode(), target); } catch { fs.copyFileSync(process.execPath, target); }
    } else {
      fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    }
  }

  for (const tool of opts.tools ?? []) {
    if (!isWin) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(dir, tool));
    } else if (tool === 'tar') {
      fs.copyFileSync(hostTar(), path.join(dir, 'tar.exe'));
    } else if (tool === 'gzip') {
      // bsdtar decompresses by itself; there is no gzip for it to call.
    } else if (tool === 'git') {
      if (!extraPath.includes(gitCmdDir())) extraPath.push(gitCmdDir());
    } else {
      throw new Error(`fakeBin: no Windows equivalent for '${tool}' - write it as a stub`);
    }
  }

  for (const [name, source] of Object.entries(opts.stubs ?? {})) {
    const script = path.join(dir, `${name}.stub.cjs`);
    fs.writeFileSync(script, source, 'utf8');
    if (isWin) {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    } else {
      const launcher = path.join(dir, name);
      fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`, 'utf8');
      fs.chmodSync(launcher, 0o755);
    }
  }

  const PATH = [dir, ...extraPath].join(path.delimiter);
  return {
    dir,
    env(extra: NodeJS.ProcessEnv = {}) {
      // On Windows a process also needs the OS plumbing - where Windows lives,
      // the shell, PATHEXT, a temp dir. None of it carries a tool.
      const plumbing: NodeJS.ProcessEnv = {};
      if (isWin) {
        for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
          if (process.env[key] !== undefined) plumbing[key] = process.env[key];
        }
      }
      return { ...plumbing, ...extra, PATH };
    },
  };
}
