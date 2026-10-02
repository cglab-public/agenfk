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

import * as path from 'path';

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

export interface PlatformProfile {
  /** The user's own shell, for a terminal opened with no agent. */
  shell(env: NodeJS.ProcessEnv): Command;
  /** The command behind the 'shell' entry of the agent list. */
  readonly shellAgent: Command;
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
  shellAgent: windowsPowerShell(process.env),
  capturesLoginPath: false,
  pathLookup: 'where',
  titleBarStyle: 'default',
  quitsWhenAllWindowsClosed: true,
  hasDock: false,
};

/*
 * Every Unix. `$SHELL` is what the person's terminal already is; /bin/sh is
 * the fallback for a GUI launch that exported none, and it is a shell on every
 * Unix we ship to. No arguments: an interactive shell is what a terminal is.
 */
const UNIX: PlatformProfile = {
  shell: env => ({ file: env.SHELL || '/bin/sh', args: [] }),
  shellAgent: { file: 'bash', args: ['-l'] },
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

/** The profile for an OS. Anything that is neither Windows nor macOS is a Unix. */
export function profileFor(os: NodeJS.Platform | string): PlatformProfile {
  if (os === 'win32') return WINDOWS;
  if (os === 'darwin') return MACOS;
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
