/**
 * Telling "could not be run" from "ran and failed" on Windows (GitHub #208).
 *
 * sh answers a missing command with exit 127, which the verify report shows as
 * itself. cmd.exe answers it with exit 1 - a red suite's code - and a message on
 * stderr in the machine's own language, so a broken PATH or a misspelt runner
 * read as failing tests. The command still runs exactly as written; only after
 * it FAILS is its first word looked up the way cmd.exe looks it up, and the
 * report names it when it resolves to nothing.
 *
 * Pure: the environment and the filesystem question are handed in.
 */
import fs from 'fs';
import path from 'path';

/** cmd.exe's own commands: on no PATH, and always found. */
const CMD_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'dpath', 'echo',
  'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'keys', 'md', 'mkdir', 'mklink', 'move', 'path',
  'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift',
  'start', 'time', 'title', 'type', 'ver', 'verify', 'vol',
]);

/**
 * Whether a lookup candidate is there for cmd.exe to run. `lstat`, not
 * `existsSync`: an App Execution Alias (Store Python, winget) is a reparse
 * point `stat` cannot open (EACCES), so existsSync calls it absent - and a red
 * `python -m pytest` would read as "python was not found".
 */
export function commandEntryExists(p: string): boolean {
  try {
    return !!fs.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return false;
  }
}

export interface WindowsLookup {
  readonly pathEnv: string;
  readonly pathExt: string;
  readonly cwd: string;
  readonly exists: (p: string) => boolean;
}

/** The command's first word, unquoted; null when there is none to read. */
function firstWord(command: string): string | null {
  const s = command.trimStart();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  const word = /^[^\s&|<>()]+/.exec(s)?.[0];
  return word ?? null;
}

/**
 * The first word of `command` when cmd.exe would find nothing to run for it -
 * not a builtin, not a file as written or with a PATHEXT extension, here or on
 * PATH - else null. null also when no first word can be read: no claim at all
 * beats a wrong one.
 */
export function missingCommandOnWindows(command: string, env: WindowsLookup): string | null {
  // `@` only silences echo; cmd.exe looks up what follows it.
  const word = firstWord(command.trimStart().replace(/^@+/, ''));
  if (!word) return null;
  // cmd.exe expands %VAR% (and !VAR! under delayed expansion) before the
  // lookup: what it then runs is not on the line to judge.
  if (/[%!]/.test(word)) return null;
  // A builtin may be glued to its argument: `echo.`, `echo:hi`, `cd..`, `cd\sub`.
  const head = /^[a-z]+(?=[.:\\/+,;=[\]]|$)/i.exec(word)?.[0];
  if (head && CMD_BUILTINS.has(head.toLowerCase())) return null;
  const exts = env.pathExt.split(';').filter(Boolean);
  const candidates = (base: string) => [base, ...exts.map(e => `${base}${e.toLowerCase()}`), ...exts.map(e => `${base}${e}`)];
  const pathy = /[\\/:]/.test(word);
  const dirs = pathy ? [''] : [env.cwd, ...env.pathEnv.split(';').filter(Boolean)];
  for (const dir of dirs) {
    const base = dir ? path.win32.join(dir, word) : path.win32.resolve(env.cwd, word);
    if (candidates(base).some(env.exists)) return null;
  }
  return word;
}
