/**
 * SX-3 (8dd7c7c0): how the server runs a card's command.
 *
 * For a card whose tree an Airlock sandbox touched (coverage.ts), while the
 * effective policy enforces, the verify, suite, capture and worktree-setup
 * commands run through `agenfk airlock exec` - inside the sandbox built from the
 * policy for a command (packages/cli/src/airlock/exec.ts) - so a command the
 * agent passed, or tests it edited, cannot use the server to get out. Every
 * other card's command runs exactly as before.
 *
 * A covered card where the sandbox cannot be used (Windows, where Airlock has no
 * sandbox; no agenfk CLI beside this server) is refused: the line printed in its
 * place says why and exits 125. Its command never runs unsandboxed.
 *
 * The result is still a shell line, so the callers keep their own spawn (shell,
 * process group, timeout kill). `--no-process-group`: they already give the line
 * a group of its own and kill that group whole, and the command stays in it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AirlockMode, StorageProvider } from '@agenfk/core';
import { airlockTreeCovered } from './coverage.js';

/** The exit of a command refused rather than run unsandboxed (exec's own "cannot sandbox"). */
export const AIRLOCK_REFUSED_EXIT = 125;

export interface AirlockRunDeps {
  storage: () => StorageProvider;
  /** The effective policy's mode (the hub's on a hub-joined installation). */
  effectiveMode: () => Promise<AirlockMode>;
  /** The agenfk CLI script (bin/agenfk.js) exec is run from. */
  cliPath: () => string;
  /** This server's own address, for exec to read the policy from (never rediscovered); null before it listens. */
  apiUrl?: () => string | null;
  nodePath?: string;
  /** Set on the line before the launcher (the desktop app: ELECTRON_RUN_AS_NODE=1, its Node being Electron). */
  lineEnv?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export interface AirlockRun {
  /** The shell line to run. */
  command: string;
  sandboxed: boolean;
  /** Why a covered card's command is not run at all. */
  refused?: string;
}

/** One POSIX shell word, verbatim. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A line that says why and exits 125, in the shell the caller runs it with (cmd.exe on Windows). */
const refusedLine = (why: string, platform: NodeJS.Platform): AirlockRun => {
  const text = `[agenfk airlock] ${why} The command was not run.`;
  const command = platform === 'win32'
    // cmd.exe has no quoting that holds every character, so the ones it treats specially go
    ? `echo ${text.replace(/[&|<>^%"()!]/g, ' ')} 1>&2 & exit /b ${AIRLOCK_REFUSED_EXIT}`
    : `printf '%s\\n' ${q(text)} >&2; exit ${AIRLOCK_REFUSED_EXIT}`;
  return { command, sandboxed: false, refused: why };
};

export async function airlockCommandFor(deps: AirlockRunDeps, itemId: string | null | undefined, command: string, cwd: string): Promise<AirlockRun> {
  const plain: AirlockRun = { command, sandboxed: false };
  const platform = deps.platform ?? process.platform;
  const refuse = (why: string): AirlockRun => refusedLine(why, platform);
  if (!itemId) return plain;
  let covered: boolean;
  try {
    covered = await airlockTreeCovered(deps.storage(), itemId);
  } catch (e) {
    // Coverage could not be read: the card may well be covered, so not plain.
    return refuse(`Could not tell whether an Airlock sandbox touched this card (${(e as Error)?.message ?? e}).`);
  }
  if (!covered) return plain;
  let mode: AirlockMode;
  try {
    mode = await deps.effectiveMode();
  } catch (e) {
    return refuse(`An Airlock sandbox touched this card, and the Airlock policy could not be read (${(e as Error)?.message ?? e}).`);
  }
  if (mode !== 'enforce') return plain;
  if (platform === 'win32') {
    return refuse('An Airlock sandbox touched this card and the policy enforces, but Airlock has no sandbox on Windows to run its commands in.');
  }
  const cli = deps.cliPath();
  if (!fs.existsSync(cli)) {
    return refuse(`An Airlock sandbox touched this card and the policy enforces, but the agenfk CLI that runs commands in the sandbox is not at ${cli}.`);
  }
  // exec reads the policy from THIS server, never one it would rediscover.
  const url = deps.apiUrl?.() ?? null;
  return {
    command: [
      ...(url ? [`AGENFK_API_URL=${q(url)}`] : []),
      ...Object.entries(deps.lineEnv ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${q(v)}`),
      q(deps.nodePath ?? process.execPath), q(cli), 'airlock', 'exec', '--no-process-group', '--cwd', q(cwd), '--', q(command),
    ].join(' '),
    sandboxed: true,
  };
}

/**
 * A flow command check's argv for a card (commandChecks.ts): unchanged for a card
 * nobody sandboxed; for a covered one, its words quoted into one line and run
 * through exec by /bin/sh; refused (with why) where the sandbox cannot be used.
 */
export async function airlockArgvFor(deps: AirlockRunDeps, itemId: string | null | undefined, argv: string[], cwd: string): Promise<{ argv: string[]; refused?: string; processGroup?: boolean }> {
  const run = await airlockCommandFor(deps, itemId, argv.map(q).join(' '), cwd);
  if (run.refused) return { argv, refused: run.refused };
  // its own process group, so a timeout ends everything it started (exec keeps the command in it)
  return run.sandboxed ? { argv: ['/bin/sh', '-c', run.command], processGroup: true } : { argv };
}

/** This server's address for exec, from the host it binds and its port: an IPv6 host bracketed, the wildcard as loopback. */
export function serverUrlFor(host: string, port: number | null): string | null {
  if (!port) return null;
  const h = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/**
 * Should the server's own git commands for this card (the close commit, a
 * worktree add) run with hooks off? Hooks are the repository's code, which a
 * sandboxed agent may have changed: for a covered card while the policy
 * enforces, yes - and also when that cannot be told.
 */
export async function airlockHooksOff(deps: AirlockRunDeps, itemId: string | null | undefined): Promise<boolean> {
  if (!itemId) return false;
  try {
    if (!(await airlockTreeCovered(deps.storage(), itemId))) return false;
    return (await deps.effectiveMode()) === 'enforce';
  } catch {
    return true;
  }
}

/**
 * Where hooks are looked for when they are off: /dev/null, which can hold no
 * hook. Never a directory a sandboxed command can write (a temp directory would
 * let one plant the hook the server runs next). Windows has no Airlock sandbox;
 * there, a directory under ~/.agenfk/airlock, which no sandbox may write.
 */
function noHooksTarget(): string {
  if (process.platform !== 'win32') return '/dev/null';
  const dir = path.join(os.homedir(), '.agenfk', 'airlock', 'no-hooks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** git's environment with hooks off (core.hooksPath -> nowhere), after any configuration it already carries. */
export function noHooksGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const noHooksDir = noHooksTarget();
  const n = Number(base.GIT_CONFIG_COUNT);
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  return { ...base, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${count}`]: noHooksDir };
}
