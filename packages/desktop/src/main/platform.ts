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
}

export interface PlatformProfile {
  /** The user's own shell, for a terminal opened with no agent. `account` is accountShell(). */
  shell(env: NodeJS.ProcessEnv, account?: string | null): Command;
  /** The command behind the 'shell' entry of the agent list: the same shell, as a login shell. */
  shellAgent(env: NodeJS.ProcessEnv, account?: string | null): Command;
  /** Whether a login shell exists to recover the PATH a GUI launch lacks. */
  readonly capturesLoginPath: boolean;
  /** The executable that finds a command on PATH. */
  readonly pathLookup: 'where' | 'which';
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
 * POSIX path (/usr/bin/bash) node-pty cannot open. powershell.exe takes no -l;
 * there is no login shell to capture a PATH from, because a Windows GUI launch
 * already has the user's.
 */
const windowsPowerShell = (env: NodeJS.ProcessEnv): Command => ({
  file: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  args: [],
});

const WINDOWS: PlatformProfile = {
  shell: windowsPowerShell,
  shellAgent: windowsPowerShell,
  capturesLoginPath: false,
  pathLookup: 'where',
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
  capturesLoginPath: true,
  pathLookup: 'which',
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
