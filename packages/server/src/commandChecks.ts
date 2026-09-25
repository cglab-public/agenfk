/**
 * efcacdeb (C2) — command checks: a command the flow defines, which the server
 * runs in the card's tree before the engine judges the step.
 *
 * - argv, never a shell: each argument reaches the program exactly as the flow
 *   wrote it, and an approval's hash means exactly what runs.
 * - Only flows from the org's hub or made on this machine: one installed from
 *   the community registry (origin 'registry') never runs its commands.
 * - A check that asks for it (approval: person) runs only once a person
 *   approved that exact argv on the board with a passkey; any change asks again.
 * - The environment is the server's, minus agenfk's own variables.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import type { ResolvedCheck } from '@agenfk/core';

export interface CommandApproval { hash: string; argv: string[]; at: string; by: string; authority: string; credentialId?: string }
export interface CommandVerdict {
  outcome: 'pass' | 'fail' | 'unavailable';
  detail: string;
  /** C3b: ran or not, the approval it ran under, or the command it waits on. */
  meta?: { ran?: boolean; approval?: { by: string; at: string; authority?: string }; waiting?: { kind: 'command-approval'; hash: string; command: string } };
}

/** What an approval pins: the exact argv. */
export const argvHash = (argv: readonly string[]): string => crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex');

/** The server's environment without agenfk's own variables (tokens, paths, ports). */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('AGENFK_')) out[k] = v;
  return out;
}

const TAIL = 2000;
const tail = (s: string) => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s).trim();

/** A command as a person reads it: its arguments, quoted where a space or symbol needs it (83e4e956). */
export const commandLine = (argv: readonly string[]): string =>
  // A JSON string: quotes AND backslashes escaped, which a hand-rolled quote replace missed.
  argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');

/** What the check says: one readable line, then the output's tail - short enough for the history to keep whole. */
const DETAIL_MAX = 500;
const withOutput = (line: string, output: string) => {
  if (!output) return line;
  const room = DETAIL_MAX - line.length - 2;
  return room > 0 ? `${line}\n${output.length > room ? `…${output.slice(-(room - 1))}` : output}` : line;
};

/** Run one argv in `cwd`: its exit code (null when killed) and the tail of its output. */
export function runArgv(argv: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; notFound?: boolean; timedOut?: boolean }> {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { cwd, env: commandEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err: any, stdout, stderr) => {
      const output = tail(`${stdout ?? ''}${stderr ?? ''}`);
      if (!err) return resolve({ exitCode: 0, output });
      if (err.code === 'ENOENT') return resolve({ exitCode: null, output, notFound: true });
      resolve({ exitCode: typeof err.code === 'number' ? err.code : null, output, timedOut: !!err.killed });
    });
  });
}

/** Run the step's command checks and judge each, keyed by the resolved check id. */
export async function judgeCommandChecks(
  checks: readonly ResolvedCheck[],
  ctx: { root: string | null; origin?: string; approvals: readonly CommandApproval[]; timeoutMs: number },
): Promise<Record<string, CommandVerdict>> {
  const out: Record<string, CommandVerdict> = {};
  for (const c of checks) {
    let argv: string[] = [];
    try { argv = JSON.parse(c.params.argv); } catch { /* validated at save time */ }
    const shown = commandLine(argv);
    if (ctx.origin === 'registry') {
      out[c.id] = { outcome: 'fail', detail: `not run: this flow was installed from the community registry, and only flows from your org's hub or made on this machine may run commands. Publish it through your hub, or copy it into a local flow, to use ${shown}.` };
      continue;
    }
    if (!ctx.root) { out[c.id] = { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree) to run the command in' }; continue; }
    const hash = argvHash(argv);
    const approved = c.params.approval === 'person' ? ctx.approvals.find(a => a.hash === hash) : undefined;
    if (c.params.approval === 'person' && !approved) {
      out[c.id] = { outcome: 'fail', detail: `waiting for a person to approve the command ${shown} on the board (signed with a passkey). It runs once approved, and asks again if it changes.`, meta: { waiting: { kind: 'command-approval', hash, command: shown } } };
      continue;
    }
    // The approval it ran under, stamped now: a later re-approval replaces the record.
    const meta = { ran: true, ...(approved ? { approval: { by: approved.by, at: approved.at, authority: approved.authority } } : {}) };
    const r = await runArgv(argv, ctx.root, ctx.timeoutMs);
    out[c.id] = r.exitCode === 0
      ? { outcome: 'pass', detail: withOutput(`${shown} exited 0`, r.output), meta }
      : { outcome: 'fail', detail: r.notFound ? `${shown}: program not found (${argv[0]})` : withOutput(`${shown} ${r.timedOut ? 'timed out' : `exited ${r.exitCode ?? 'without a code (killed)'}`}`, r.output), meta };
  }
  return out;
}
