/**
 * Everything the main process does differently per operating system, in one
 * place (card 2fd7c65c).
 *
 * The main process used to ask `process.platform` in seven places, each with
 * its own guess, and the guesses drifted: the shell was `$SHELL || '/bin/sh'`
 * on every OS, so on Windows - which exports no SHELL - node-pty was handed
 * /bin/sh and "Open terminal" failed with `File not found`. A profile per OS is
 * chosen once, below; the rest of the main process reads it and never asks.
 *
 * The renderer still learns the platform through the preload. That is
 * information for the UI, not a decision made here.
 */

import * as os from 'os';
import * as path from 'path';

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Windows only: the whole command line, already escaped. node-pty passes a
   * string through verbatim, where an array would be re-quoted around our
   * escaping. Set only by `launch` for a script that has to go through cmd.exe.
   */
  readonly commandLine?: string;
}

/**
 * How to learn the PATH a terminal opened NOW would have (story 1b9d622e).
 *
 * The app's own PATH is the wrong answer on every OS, for different reasons: a
 * Mac app opened from the Finder gets launchd's minimal one, and a Windows app
 * keeps whatever it was started with, so an agent installed while it is open
 * never appears. Nothing here names an installer - npm, brew, nvm, scoop and
 * the rest all end on this PATH, and it is the only thing consulted.
 */
export interface FreshPath {
  command(env: NodeJS.ProcessEnv, account?: string | null): Command;
  /** 'env' prints a whole environment to read PATH out of; 'path' prints only the PATH. */
  readonly output: 'env' | 'path';
}

export interface PlatformProfile {
  /** The user's own shell, for a terminal opened with no agent. `account` is accountShell(). */
  shell(env: NodeJS.ProcessEnv, account?: string | null): Command;
  /** The command behind the 'shell' entry of the agent list: the same shell, as a login shell. */
  shellAgent(env: NodeJS.ProcessEnv, account?: string | null): Command;
  readonly freshPath: FreshPath;
  /** The executable that finds a command on PATH. */
  readonly pathLookup: 'where' | 'which';
  readonly pathDelimiter: ':' | ';';
  /** Windows treats Path and PATH as one variable; a Unix does not. */
  readonly envKeysIgnoreCase: boolean;
  /** Which of the lines `pathLookup` printed can actually be started, or null. */
  pickExecutable(found: readonly string[]): string | null;
  /** How to start an executable `pickExecutable` chose. */
  launch(resolved: string, args: readonly string[], env: NodeJS.ProcessEnv): Command;
  readonly titleBarStyle: 'hiddenInset' | 'default';
  /** macOS keeps an app running with no windows; the others quit. */
  readonly quitsWhenAllWindowsClosed: boolean;
  readonly hasDock: boolean;
}

/*
 * Windows. PowerShell ships with every supported Windows. By ABSOLUTE path:
 * node-pty's ConPTY lookup searches the app's own Path - not the env handed to
 * the pty - by exact file name with no PATHEXT, and a miss is the bare
 * "File not found: " this card was opened for. $SHELL is ignored on purpose:
 * when it is set at all it was inherited from Git Bash or MSYS, and it is a
 * POSIX path (/usr/bin/bash) node-pty cannot open. powershell.exe takes no -l.
 * There is no login shell either, but the app's Path is still stale - it is the
 * one the app was started with - so `freshPath` reads the current one.
 */
const windowsPowerShell = (env: NodeJS.ProcessEnv): Command => ({
  file: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  args: [],
});

/*
 * The Path a new process would get: the machine's and the user's, read from
 * where Windows keeps them, not from this process's copy. -NoProfile because a
 * profile is a script, and an execution policy of Restricted refuses it with an
 * error on stdout that is not a PATH.
 */
const WINDOWS_FRESH_PATH = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
  + "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";

/** What Windows starts from a bare name. A file `where` lists without one of these - npm's sh shim - cannot run here. */
const WINDOWS_RUNNABLE = /\.(exe|com|cmd|bat)$/i;
/** Scripts CreateProcess cannot start: they need cmd.exe. */
const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;

/*
 * cmd.exe metacharacters, escaped with ^ - the escaping cross-spawn uses for
 * the same job. The arguments include the card's first prompt, which is free
 * text: unescaped, an & or | in it would start a second program.
 *
 * Arguments are escaped TWICE. cmd parses `/c "<line>"` once, and the batch
 * file it starts - npm's shim runs `"%_prog%" "...cli.js" %*` - has its line
 * parsed again after %* is expanded. Escaped once, a quote in the prompt closes
 * a quoted run in that second parse and whatever follows `&` runs (the
 * BatBadBut class). The second ^ survives the first parse for the second.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const cmdEscapeCommand = (file: string): string => file.replace(CMD_META, '^$1');
const cmdEscapeArgument = (arg: string): string => {
  // cmd.exe ends the command at a line break, and no escape carries one, so
  // a multi-line prompt would lose everything after its first line. A space
  // keeps the words; a card's paragraphs read the same to an agent.
  const oneLine = arg.replace(/\r?\n/g, ' ');
  // MSVC argv rules first (the program parses its own command line), then
  // cmd's: the quotes become literal for cmd, so they are escaped too.
  let quoted = oneLine.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  return `"${quoted}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
};

const WINDOWS: PlatformProfile = {
  shell: windowsPowerShell,
  shellAgent: windowsPowerShell,
  freshPath: {
    command: env => ({
      file: windowsPowerShell(env).file,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_FRESH_PATH],
    }),
    output: 'path',
  },
  pathLookup: 'where',
  pathDelimiter: ';',
  envKeysIgnoreCase: true,
  pickExecutable: found => found.find(f => WINDOWS_RUNNABLE.test(f)) ?? null,
  launch: (resolved, args, env) => {
    if (!WINDOWS_SCRIPT.test(resolved)) return { file: resolved, args };
    const line = [cmdEscapeCommand(resolved), ...args.map(cmdEscapeArgument)].join(' ');
    return {
      file: env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      args: [],
      // /v:off: delayed expansion follows the registry otherwise, and with it
      // on a ! in the prompt brings a caret-removal pass that undoes the escaping.
      commandLine: `/d /v:off /s /c "${line}"`,
    };
  },
  titleBarStyle: 'default',
  quitsWhenAllWindowsClosed: true,
  hasDock: false,
};

/*
 * Every Unix. Nothing is assumed about which shell: zsh, bash and fish are
 * all common, and minimal systems (Alpine, containers, the BSDs) ship no bash
 * at all. `$SHELL` is what the person's terminal already is; a GUI launch that
 * exported none still has the account's shell - unless that is nologin or
 * false, a service account's way of saying "no shell", which would print
 * "This account is currently not available" and exit; /bin/sh is on every
 * Unix. The Shell agent is that same shell as a login shell (card df675f82 -
 * it used to be `bash -l` for everyone), with -l only for the shells known to
 * take it: elvish, for one, refuses it, and an unknown shell opens fine
 * without it.
 */
const NOT_A_SHELL = new Set(['nologin', 'false']);
const TAKES_LOGIN_FLAG = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'mksh', 'oksh', 'loksh', 'yash', 'tcsh', 'csh', 'nu', 'xonsh', 'pwsh',
]);

const userShell = (env: NodeJS.ProcessEnv, account?: string | null): string =>
  env.SHELL || (account && !NOT_A_SHELL.has(path.posix.basename(account)) ? account : '') || '/bin/sh';

const loginArgs = (shell: string): string[] =>
  (TAKES_LOGIN_FLAG.has(path.posix.basename(shell)) ? ['-l'] : []);

const UNIX: PlatformProfile = {
  shell: (env, account) => ({ file: userShell(env, account), args: [] }),
  shellAgent: (env, account) => {
    const file = userShell(env, account);
    return { file, args: loginArgs(file) };
  },
  // The user's own shell, as the terminal opens it, asked for its environment.
  freshPath: {
    command: (env, account) => ({ file: userShell(env, account), args: ['-lic', 'env'] }),
    output: 'env',
  },
  pathLookup: 'which',
  pathDelimiter: ':',
  envKeysIgnoreCase: false,
  pickExecutable: found => found[0] ?? null,
  launch: (resolved, args) => ({ file: resolved, args }),
  titleBarStyle: 'default',
  quitsWhenAllWindowsClosed: true,
  hasDock: false,
};

const MACOS: PlatformProfile = {
  ...UNIX,
  titleBarStyle: 'hiddenInset',
  quitsWhenAllWindowsClosed: false,
  hasDock: true,
};

/**
 * The shell on the account's passwd entry, or null. os.userInfo() throws where
 * the uid has no entry (some containers), and a missing shell must never stop
 * a terminal from opening.
 */
export function accountShell(): string | null {
  try {
    return os.userInfo().shell || null;
  } catch {
    return null;
  }
}

/** The profile for an OS. Anything that is neither Windows nor macOS is a Unix. */
export function profileFor(name: NodeJS.Platform | string): PlatformProfile {
  if (name === 'win32') return WINDOWS;
  if (name === 'darwin') return MACOS;
  return UNIX;
}

/**
 * The OS the app is running on - the OS it was built for. The one read of
 * `process.platform` in the main process; tmux detection takes it as a value
 * because its install hints are its own table (./tmux.ts).
 */
export const runningOn: NodeJS.Platform = process.platform;

/** The profile of the OS the app is running on. */
export const platform: PlatformProfile = profileFor(runningOn);
