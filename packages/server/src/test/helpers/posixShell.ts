import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * The POSIX shell server specs run their git fixture strings in (GitHub #208).
 *
 * The fixtures are shell strings (`git init -q -b main && ... && echo a > a`),
 * and they used to hard-code `/bin/sh` as their shell, which native Node on Windows does
 * not have. Git for Windows - a hard requirement of AgEnFK - ships a POSIX
 * `sh.exe` beside git itself, so on win32 this names that one, found from
 * `git --exec-path` (`<git root>/<mingw64|ucrt64|...>/libexec/git-core`).
 * Everywhere else it is `/bin/sh`, exactly as before.
 */
export interface PosixShellDeps {
  platform: NodeJS.Platform;
  gitExecPath: () => string;
  exists: (p: string) => boolean;
}

const defaults: PosixShellDeps = {
  platform: process.platform,
  gitExecPath: () => execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }),
  exists: (p) => fs.existsSync(p),
};

let cached: string | undefined;

export function posixShell(deps?: PosixShellDeps): string {
  if (!deps && cached) return cached;
  const { platform, gitExecPath, exists } = deps ?? defaults;
  if (platform !== 'win32') return '/bin/sh';
  const gitRoot = path.win32.resolve(gitExecPath().trim(), '..', '..', '..');
  const candidates = [path.win32.join(gitRoot, 'bin', 'sh.exe'), path.win32.join(gitRoot, 'usr', 'bin', 'sh.exe')];
  const found = candidates.find(exists);
  if (!found) {
    throw new Error(`No sh.exe found in Git for Windows (looked at ${candidates.join(', ')}); the server specs need its POSIX shell`);
  }
  if (!deps) cached = found;
  return found;
}

let cachedBash: string | undefined;

/**
 * The bash a spec runs a repository script with (`bash scripts/x.sh`), found
 * like posixShell() finds sh.exe: Git for Windows' own bash.exe on win32, and
 * `bash` everywhere else. Not whatever `bash` PATH names first - from PowerShell
 * or cmd that is WSL's System32\bash.exe, which reads `C:\Users\...` as
 * `C:Users...` and runs nothing (#208).
 */
export function posixBash(deps?: PosixShellDeps): string {
  if (!deps && cachedBash) return cachedBash;
  const { platform, gitExecPath, exists } = deps ?? defaults;
  if (platform !== 'win32') return 'bash';
  const gitRoot = path.win32.resolve(gitExecPath().trim(), '..', '..', '..');
  const candidates = [path.win32.join(gitRoot, 'bin', 'bash.exe'), path.win32.join(gitRoot, 'usr', 'bin', 'bash.exe')];
  const found = candidates.find(exists);
  if (!found) {
    throw new Error(`No bash.exe found in Git for Windows (looked at ${candidates.join(', ')}); this spec needs its bash`);
  }
  if (!deps) cachedBash = found;
  return found;
}

/**
 * One value as a single POSIX shell word. A path interpolated bare into a
 * fixture string loses its backslashes to the shell on Windows
 * (`C:\Users\x` arrives as `C:Usersx`), and breaks on a space anywhere.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
