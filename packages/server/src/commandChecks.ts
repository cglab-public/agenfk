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
  meta?: { ran?: boolean; approval?: { by: string; at: string; authority?: string }; waiting?: { kind: 'command-approval'; hash: string; command: string }; reusedFrom?: { itemId: string; at: string } };
}

/**
 * 3ffc9651 — who may share a pass: `scope` is the project and tree, `state`
 * reads the tree's state (HEAD, the index, and every tracked and untracked
 * file's content) or null when it cannot say, and `itemId` is the card asking.
 */
export interface CommandShare { scope: string; itemId: string; state: () => string | null }

/**
 * Passes, by scope, argv and tree state: a command check sees its argv, its
 * tree's files, the index and HEAD, so another card at the same state would run
 * it on the same inputs - a command that reads the network opts out (share: none).
 * Only a pass whose run left the tree as it found it is kept; a failure may be a
 * flake and N cards should not inherit one. In memory: a restart runs it again.
 */
const sharedPasses = new Map<string, { itemId: string; at: string; verdict: CommandVerdict }>();
const SHARED_MAX = 500;
/** Command checks running now, by the same key: a card arriving meanwhile waits for the run. */
const commandsInFlight = new Map<string, Promise<{ verdict: CommandVerdict; itemId: string; kept: boolean }>>();

/**
 * How long a kept pass answers (3ffc9651 review): the state pins the tree, not
 * the world around it - what git ignores, a tool's version, the clock. Ten
 * minutes by default: enough for siblings finishing together, not for a day.
 */
const shareTtlMs = (): number => {
  const n = Number(process.env.AGENFK_COMMAND_SHARE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
};
function freshPass(key: string): { itemId: string; at: string; verdict: CommandVerdict } | undefined {
  const entry = sharedPasses.get(key);
  if (entry && Date.now() - Date.parse(entry.at) > shareTtlMs()) { sharedPasses.delete(key); return undefined; }
  return entry;
}

function keepShared(key: string, entry: { itemId: string; at: string; verdict: CommandVerdict }): void {
  sharedPasses.delete(key);
  sharedPasses.set(key, entry);
  if (sharedPasses.size > SHARED_MAX) sharedPasses.delete(sharedPasses.keys().next().value as string);
}

const reusedVerdict = (shown: string, from: { itemId: string; at: string; verdict: CommandVerdict }): CommandVerdict => ({
  outcome: 'pass',
  detail: `reused: ${shown} exited 0 in the run of card ${from.itemId.slice(0, 8)} at ${from.at}, at this same tree state (HEAD, index and every file's content), so it was not run again`,
  meta: { ran: false, reusedFrom: { itemId: from.itemId, at: from.at }, ...(from.verdict.meta?.approval ? { approval: from.verdict.meta.approval } : {}) },
});

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

/** A command check whose command a person must approve, and has not (C3b): it is never run. */
export function awaitsPersonApproval(c: ResolvedCheck, approvals: readonly CommandApproval[]): boolean {
  if (c.params.approval !== 'person') return false;
  let argv: string[] = [];
  try { argv = JSON.parse(c.params.argv); } catch { /* validated at save time */ }
  return !approvals.some(a => a.hash === argvHash(argv));
}

/** Run the step's command checks and judge each, keyed by the resolved check id. */
export async function judgeCommandChecks(
  checks: readonly ResolvedCheck[],
  ctx: { root: string | null; origin?: string; approvals: readonly CommandApproval[]; timeoutMs: number; share?: CommandShare },
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
    if (awaitsPersonApproval(c, ctx.approvals)) {
      out[c.id] = { outcome: 'fail', detail: `waiting for a person to approve the command ${shown} on the board (signed with a passkey). It runs once approved, and asks again if it changes.`, meta: { waiting: { kind: 'command-approval', hash, command: shown } } };
      continue;
    }
    // The approval it ran under, stamped now: a later re-approval replaces the record.
    const meta = { ran: true, ...(approved ? { approval: { by: approved.by, at: approved.at, authority: approved.authority } } : {}) };
    const root = ctx.root;
    const run = async (): Promise<CommandVerdict> => {
      const r = await runArgv(argv, root, ctx.timeoutMs);
      return r.exitCode === 0
        ? { outcome: 'pass', detail: withOutput(`${shown} exited 0`, r.output), meta }
        : { outcome: 'fail', detail: r.notFound ? `${shown}: program not found (${argv[0]})` : withOutput(`${shown} ${r.timedOut ? 'timed out' : `exited ${r.exitCode ?? 'without a code (killed)'}`}`, r.output), meta };
    };
    out[c.id] = ctx.share && c.params.share !== 'none' ? await runShared(ctx.share, hash, shown, run) : await run();
  }
  return out;
}

/**
 * 3ffc9651 — one run per scope, argv and tree state. A kept pass answers at
 * once; a run in flight is waited on and its pass taken if it was kept;
 * anything else runs the command. The state is read before and after the
 * run: a run that saw the tree change is this card's result, never shared.
 */
async function runShared(share: CommandShare, hash: string, shown: string, run: () => Promise<CommandVerdict>): Promise<CommandVerdict> {
  // Bounded: a tree that keeps changing under us stops waiting and runs.
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = share.state();
    if (!state) return run();
    const key = [share.scope, hash, state].join('\0');
    const kept = freshPass(key);
    if (kept) return reusedVerdict(shown, kept);
    const running = commandsInFlight.get(key);
    if (running) {
      let theirs: { verdict: CommandVerdict; itemId: string; kept: boolean } | null = null;
      try { theirs = await running; } catch { /* its crash is not this card's: start over */ }
      if (theirs?.kept) {
        const entry = freshPass(key);
        if (entry) return reusedVerdict(shown, entry);
      }
      // A failure is not shared, and the tree may have moved: ask again from the top.
      if (theirs && !theirs.kept && theirs.verdict.outcome !== 'pass') return run();
      continue;
    }
    const flight = (async () => {
      const verdict = await run();
      const keep = verdict.outcome === 'pass' && share.state() === state;
      if (keep) keepShared(key, { itemId: share.itemId, at: new Date().toISOString(), verdict });
      return { verdict, itemId: share.itemId, kept: keep };
    })();
    commandsInFlight.set(key, flight);
    try {
      return (await flight).verdict;
    } finally {
      if (commandsInFlight.get(key) === flight) commandsInFlight.delete(key);
    }
  }
  return run();
}
