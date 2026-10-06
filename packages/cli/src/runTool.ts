/**
 * Launching an AI client CLI (claude) from the CLI, on every platform
 * (BUG ad57c267).
 *
 * On Windows a client is either a native .exe (Claude Code's own installer) or
 * an npm .cmd shim, and Node refuses to spawn a .cmd without a shell
 * (CVE-2024-27980: spawnSync answers EINVAL). So the client is found on PATH
 * here - only PATH, never the current directory, and only as .exe/.cmd/.bat
 * (cmd.exe would also look in the cwd and try .js/.vbs, running a repo's stray
 * claude.js instead of Claude Code). An .exe is spawned directly; a .cmd/.bat
 * goes through cmd.exe with its absolute path.
 *
 * Mirrors scripts/client-cli.mjs, which the installer and uninstaller use;
 * keep the two in step.
 */
import { spawnSync, SpawnSyncOptions, SpawnSyncReturns } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';

// Arguments made only of these reach cmd.exe as they are; anything else is
// double-quoted, which keeps spaces and & | < > ^ ( ) , = literal. Limits of
// the cmd.exe route (shims only - an .exe never sees cmd.exe): a %NAME% inside
// quotes is still expanded when NAME is set, and '!' is eaten when delayed
// expansion is on in the registry. The paths the CLI passes (db, bin) do not
// carry either in practice.
const WIN_BARE_ARG = /^[A-Za-z0-9_\-.:/\\@+]+$/;
const WIN_LAUNCHABLE = ['.exe', '.cmd', '.bat'];

function quoteWindowsArg(name: string, arg: string): string {
  const s = String(arg);
  if (s.includes('"')) {
    throw new Error(`Cannot pass an argument holding a double quote to ${name} through cmd.exe: ${s}`);
  }
  if (WIN_BARE_ARG.test(s)) return s;
  // Backslashes before the closing quote are doubled, or the program's argv
  // parser reads `\"` as an escaped quote and the argument runs on.
  return `"${s.replace(/(\\+)$/, '$1$1')}"`;
}

/** The command line cmd.exe is handed to run `file args...`; a '"' in an argument is refused. */
export function windowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map((a) => quoteWindowsArg(file, a)).join(' ');
}

/**
 * Anything but a directory. A Windows Store app alias is a reparse point that
 * stat either fails on or reports as a symlink (not a file) - both still launch.
 */
function isLaunchable(file: string): boolean {
  try {
    return !statSync(file).isDirectory();
  } catch {
    return true;
  }
}

/**
 * The client's launchable file on PATH (.exe/.cmd/.bat, in PATHEXT order), or
 * null. The current directory is not searched.
 */
export function resolveWindowsTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = (k: string) => Object.keys(env).find((e) => e.toUpperCase() === k) ?? k;
  const dirs = String(env[key('PATH')] ?? '').split(';').map((d) => d.replace(/^"|"$/g, ''))
    // A relative entry ('.', node_modules\.bin) would be the cwd lookup again.
    .filter((d) => d && path.isAbsolute(d));
  const exts = String(env[key('PATHEXT')] ?? '.EXE;.CMD;.BAT').split(';')
    .map((e) => e.toLowerCase()).filter((e) => WIN_LAUNCHABLE.includes(e));
  if (exts.length === 0) exts.push(...WIN_LAUNCHABLE); // PATHEXT set but empty: cmd.exe's defaults
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (existsSync(file) && isLaunchable(file)) return file;
      } catch { /* unreadable PATH entry - keep looking */ }
    }
  }
  return null;
}

/**
 * spawnSync for a client CLI by bare name, on every platform. A client that is
 * not installed answers status null with an ENOENT error, as spawnSync does.
 * On Windows a timeout or kill aimed at a .cmd/.bat client reaches cmd.exe,
 * not the program the shim started.
 */
export function runTool(name: string, args: readonly string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  if (process.platform !== 'win32') return spawnSync(name, args, { windowsHide: true, ...opts });
  const file = resolveWindowsTool(name, opts.env ?? process.env);
  if (!file) {
    const error = Object.assign(new Error(`spawnSync ${name} ENOENT`), { code: 'ENOENT', syscall: `spawnSync ${name}`, path: name });
    return { pid: 0, output: [null, null, null], stdout: null as any, stderr: null as any, status: null, signal: null, error };
  }
  if (file.toLowerCase().endsWith('.exe')) return spawnSync(file, args, { windowsHide: true, ...opts });
  return spawnSync(windowsCommandLine(file, args), { windowsHide: true, ...opts, shell: true });
}
