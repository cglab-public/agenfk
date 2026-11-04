/**
 * Terminals in WSL, from the Windows app (INFRA-425).
 *
 * The Windows build adopts a server that runs inside WSL, and that server
 * answers every worktree with a Linux path. PowerShell cannot open one — there
 * is no Windows directory called /home/... — so on Windows a terminal runs
 * inside a WSL distro, through wsl.exe:
 *
 *   - ALWAYS when its directory is a Linux path, because nothing else can;
 *   - for every terminal, once the person picks a distro in Settings.
 *
 * Everything here is pure: the decision and the command line. Running wsl.exe
 * to list distros, and asking which OS this is, happen elsewhere (index.ts and
 * platform.ts), so this file can be tested on any machine.
 */

import * as path from 'path';

/**
 * The command line the agent runs under, inside the distro.
 *
 * FIXED, and that is the security property of this file. A card's text becomes
 * an argument to the agent, and it travels through wsl.exe into a shell. It
 * reaches the agent as a positional parameter — `$0` is the program, `$@` its
 * arguments — so no shell ever parses it. Splicing argv into this string
 * instead would make every backtick and `$(...)` in a card a command.
 *
 * Through the person's OWN login shell, interactive, because that is where
 * ~/.local/bin, mise shims and nvm put agents on PATH: a bare `wsl.exe --exec
 * claude` sees the distro's default PATH and reports "not found" for an agent
 * used every day. bash and zsh read their rc files with `-lic`; any other shell
 * (fish, or none recorded) gets POSIX sh as a login shell, which reads
 * ~/.profile. `exec` so the agent replaces the shell: its exit code is the
 * terminal's, and no idle shell is left behind it.
 *
 * Run by /bin/sh, which every distro has (Alpine ships no bash). Its own `$0`
 * is a label; the agent and its arguments follow it untouched.
 *
 * A .bashrc that replaces the shell for interactive sessions (`exec zsh`, or
 * attaching to tmux or herdr when not already inside one) would replace it here
 * too. `TERM_PROGRAM=agenfk` reaches the distro (see FORWARDED) so such a line
 * can step aside for these terminals.
 */
export const WSL_LOGIN_EXEC = [
  'shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
  'case "${shell##*/}" in',
  '  bash|zsh) exec "$shell" -lic \'exec "$0" "$@"\' "$@" ;;',
  '  *) exec /bin/sh -lc \'exec "$0" "$@"\' "$@" ;;',
  'esac',
].join('\n');

/** What `$0` reads as inside WSL_LOGIN_EXEC. Only a label in `ps` output. */
const EXEC_LABEL = 'agenfk-wsl';

/**
 * wsl.exe by absolute path, as platform.ts does for PowerShell and cmd: a bare
 * name is looked up in the current directory before PATH on Windows.
 */
export const wslExecutable = (env: NodeJS.ProcessEnv): string =>
  path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'wsl.exe');

/*
 * Engines that register themselves as distros: Docker Desktop, Rancher
 * Desktop, Podman. Not somewhere a person works.
 */
const NOT_A_WORKSPACE = /^(docker-desktop(-data)?|rancher-desktop(-data)?|podman-machine-.*)$/i;

/*
 * The names WSL itself allows. Anything else in the output is not a distro (a
 * banner, an error printed in the wrong encoding) and must never reach
 * `--distribution` — least of all something starting with a dash.
 */
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The distro names `wsl.exe --list --quiet` printed.
 *
 * UTF-16LE by default, whatever the console code page, with a BOM on some
 * builds and CRLF line ends; UTF-8 when WSL_UTF8=1 is set, which people set
 * precisely to make tools like this work. Told apart by the NUL bytes UTF-16
 * puts beside every ASCII character. The default distro is listed FIRST.
 */
export function parseDistroList(output: Buffer): string[] {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\0/g, '').trim())
    .filter(name => DISTRO_NAME.test(name) && !NOT_A_WORKSPACE.test(name));
}

/** An absolute POSIX path: a directory only WSL can open from Windows. */
export const isLinuxPath = (p: string): boolean => p.startsWith('/');

export interface WslTarget {
  /** null: wsl.exe's own default distro, which needs no list to name. */
  readonly distro: string | null;
}

/**
 * Where a terminal runs: in a distro, or (null) the way it always has.
 *
 * `preference` is the distro chosen in Settings, '' for none. A stored name
 * that is not in the list is ignored rather than passed to wsl.exe.
 *
 * A Linux path ALWAYS goes to WSL, and without needing the list: when nobody
 * chose, wsl.exe's own default is named by leaving `--distribution` off. So a
 * cold VM that made the listing time out costs the person their preference for
 * a moment, never their terminal.
 */
export function chooseWslTarget(opts: {
  onWindows: boolean;
  distros: readonly string[];
  preference: string;
  cwd: string;
}): WslTarget | null {
  if (!opts.onWindows) return null;
  const chosen = opts.preference && opts.distros.includes(opts.preference) ? opts.preference : null;
  if (chosen) return { distro: chosen };
  return isLinuxPath(opts.cwd) ? { distro: null } : null;
}

/**
 * The wsl.exe invocation.
 *
 * `cwd: null` is a terminal that belongs to no directory, which opens in the
 * distro's home: `~` is understood by `--cd` itself, so no Linux path has to be
 * guessed from the Windows side.
 *
 * Without a `command` it is the distro's own login shell, exactly what opening
 * the distro from the Start menu gives.
 */
export function wslLaunch(opts: {
  distro: string | null;
  cwd: string | null;
  command?: { file: string; args: readonly string[] };
  exe?: string;
}): { file: string; args: string[]; commandLine: string } {
  const file = opts.exe ?? 'wsl.exe';
  const where = [...(opts.distro ? ['--distribution', opts.distro] : []), '--cd', opts.cwd ?? '~'];
  const args = opts.command
    ? [...where, '--exec', '/bin/sh', '-c', WSL_LOGIN_EXEC, EXEC_LABEL, opts.command.file, ...opts.command.args]
    : where;
  return { file, args, commandLine: windowsCommandLine(args) };
}

/**
 * argv as ONE Windows command line, quoted the way CommandLineToArgvW reads it
 * back — which is how wsl.exe splits what follows `--exec`.
 *
 * Built here rather than left to node-pty, and that was MEASURED, not assumed:
 * node-pty passes an argument that already starts and ends with `"` through
 * unquoted, so `"Fix the parser" then "x"` reached the agent as eight words.
 * Nothing executed, but a card's text arrived mangled. The spawner already
 * passes a string through verbatim (the cmd.exe launch uses the same door).
 *
 * The rules: an argument with no whitespace or quote goes as it is; any other
 * is wrapped in quotes, each `"` escaped with a backslash, and backslashes
 * doubled only where they precede a quote (inside the text or at the end,
 * before the closing quote). Newlines inside quotes survive, which the login
 * script needs.
 */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map(arg => {
    if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
    let out = '"';
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === '\\') { backslashes += 1; continue; }
      if (ch === '"') {
        out += '\\'.repeat(backslashes * 2 + 1) + '"';
      } else {
        out += '\\'.repeat(backslashes) + ch;
      }
      backslashes = 0;
    }
    return out + '\\'.repeat(backslashes * 2) + '"';
  }).join(' ');
}

/**
 * Which of the named executables the distro's login PATH has, one per line.
 *
 * `exit 0` at the end is load-bearing: a loop's status is its last command's,
 * so without it a missing LAST agent made the whole probe exit non-zero and
 * the answer — including every agent it did find — was thrown away.
 */
export const WSL_PROBE_SCRIPT = 'for n in "$@"; do command -v "$n" >/dev/null 2>&1 && echo "$n"; done; exit 0';

/** The probe's answer: only names that were asked for, whatever an rc file printed. */
export function parseProbe(stdout: string, asked: readonly string[]): Set<string> {
  return new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => asked.includes(line)));
}

/*
 * The variables WSL must carry across. AGENFK_SESSION is the cockpit's marker
 * (INFRA-425): without it a terminal in WSL could not be told from any other. wsl.exe passes nothing from the Windows
 * environment unless WSLENV names it, so without these a terminal inside the
 * distro falls back to a TERM with no truecolor and every agent TUI draws in
 * sixteen colours. `/u`: Windows to Linux only.
 */
const FORWARDED = ['TERM', 'COLORTERM', 'TERM_PROGRAM', 'AGENFK_SESSION'];

/** The environment for wsl.exe: as given, plus the terminal type in WSLENV. */
export function withWslEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean);
  const named = new Set(existing.map(entry => entry.split('/')[0]));
  const added = FORWARDED.filter(name => !named.has(name)).map(name => `${name}/u`);
  return { ...env, WSLENV: [...existing, ...added].join(':') };
}
