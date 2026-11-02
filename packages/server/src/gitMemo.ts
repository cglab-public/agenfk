/**
 * GH #312: one verify asks git the same read-only question again and again, and
 * on Windows every spawn costs 100-600 ms. A GitMemo answers a repeated READ
 * from its first answer, for the duration of ONE verify request - created by
 * the verify and handed down explicitly, never shared across requests.
 *
 * EPOCHS. An answer stands only until the tree may have moved under it: any
 * non-git child (the suite, a command check) at its start AND at its exit, and
 * any git command that is not a known read. Those events bump a process-wide
 * generation (any request's child counts: conservative, never stale), and a
 * memo whose generation is behind forgets everything it held.
 *
 * FENCES. Some reads are re-read ON PURPOSE inside one epoch, to catch another
 * agent writing to the shared tree between two of the server's own reads. Those
 * go through `fence`: raw git, except for the questions no write by another
 * agent can change the answer to (where the root sits in its repository).
 *
 * An OUTCOME is cached, a non-zero exit (and its stderr) included: a probe that
 * exits 1 because a ref is absent answers the same the second time. A timeout
 * or an overflowing output is not an answer about the tree and is not kept.
 * Writes are never memoised.
 */
import { execFileSync, type ChildProcess } from 'child_process';
import * as path from 'path';

export type GitRunOptions = {
  /** Milliseconds; 0 for none. */
  timeout?: number;
  maxBuffer?: number;
  /** Whether git's stderr is captured on the error ('pipe') or dropped. */
  stderr?: 'pipe' | 'ignore';
};

/** Runs `git <args>` and returns its stdout; throws as execFileSync does. */
export interface GitRunner {
  run(args: readonly string[], opts?: GitRunOptions): string;
  /** The runner for a deliberate fence re-read; absent on a raw runner, which is its own fence. */
  readonly fence?: GitRunner;
}

/** execFileSync's own default: an output past this fails the call. */
export const DEFAULT_GIT_MAX_BUFFER = 1024 * 1024;

/** A runner with no memo: every call spawns git. */
export function rawGitRunner(defaults: GitRunOptions = {}): GitRunner {
  return {
    run(args, opts = {}) {
      const o = { ...defaults, ...opts };
      const out = execFileSync('git', args as string[], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', o.stderr ?? 'pipe'],
        ...(o.timeout ? { timeout: o.timeout } : {}),
        maxBuffer: o.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
        windowsHide: true,
      });
      if (!isReadOnlyGit(args)) gitStateMayHaveMoved();
      return out;
    },
  };
}

/** The fence for a runner: a memo's, or the runner itself. */
export const fenceOf = (git: GitRunner): GitRunner => git.fence ?? git;

/* ── Epochs ─────────────────────────────────────────────────────────────── */

let generation = 0;

/** The tree may have changed: every memo forgets what it read before now. */
export function gitStateMayHaveMoved(): void {
  generation++;
}

/**
 * A non-git child that may write the tree: its start ends an epoch, and so does
 * its exit, since only then is all it wrote there. Returns the child.
 */
export function noteChildProcess<T extends ChildProcess | null | undefined>(child: T): T {
  gitStateMayHaveMoved();
  child?.once?.('exit', gitStateMayHaveMoved);
  return child;
}

/* ── What only reads ─────────────────────────────────────────────────────── */

const READ_ONLY = new Set([
  'rev-parse', 'status', 'ls-files', 'diff', 'log', 'show', 'merge-base', 'for-each-ref', 'cat-file', 'rev-list',
  'check-ignore', 'ls-tree', 'describe', 'name-rev', 'symbolic-ref', 'diff-index', 'diff-files', 'diff-tree', 'show-ref',
]);

/** The subcommand and what follows it, past `-C <dir>`, `-c k=v` and other global flags. */
function subcommandOf(args: readonly string[]): { sub: string; rest: readonly string[] } {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C' || args[i] === '-c') { i++; continue; }
    if (!args[i].startsWith('-')) return { sub: args[i], rest: args.slice(i + 1) };
  }
  return { sub: '', rest: [] };
}

/**
 * A query git answers without writing: the memo may answer it. Anything else -
 * including a command not known to only read - is a write.
 */
export function isReadOnlyGit(args: readonly string[]): boolean {
  const { sub, rest } = subcommandOf(args);
  if (sub === 'remote') return rest.length === 0 || rest[0] === 'get-url';
  if (sub === 'config') return rest.some(a => a === '--get' || a === '--get-all' || a === '--list' || a === '-l');
  return READ_ONLY.has(sub);
}

/**
 * Where the root sits in its repository: no write to the tree moves it, so a
 * fence re-read may take it from the memo.
 */
function placeOnly(args: readonly string[]): boolean {
  const { sub, rest } = subcommandOf(args);
  return sub === 'rev-parse' && rest.length > 0 && rest.every(a => a === '--show-prefix' || a === '--show-toplevel');
}

/* ── The memo ────────────────────────────────────────────────────────────── */

/** Not an answer about the tree: a kill (timeout) or an overflowing output. */
function settled(e: any): boolean {
  return typeof e?.status === 'number' && !e?.signal && e?.code !== 'ENOBUFS' && e?.code !== 'ETIMEDOUT';
}

/** The query, the directory spelled one way: `C:\x` and `C:/x/` are the same tree. */
function keyOf(args: readonly string[]): string {
  const norm = args.map((a, i) => (i > 0 && args[i - 1] === '-C' ? path.resolve(a).replace(/\\/g, '/') : a));
  return JSON.stringify(norm);
}

export interface GitMemo extends GitRunner {
  readonly fence: GitRunner;
  /** The runner underneath: every call spawns. */
  readonly raw: GitRunner;
}

/** A memo for ONE verify. Never keep it past the request that made it. */
export function createGitMemo(raw: GitRunner): GitMemo {
  const answers = new Map<string, { out: string } | { err: unknown }>();
  let at = generation;
  const run = (args: readonly string[], opts: GitRunOptions = {}): string => {
    if (!isReadOnlyGit(args)) {
      // A write ends the epoch it ran in, and what is read after it is read afresh.
      gitStateMayHaveMoved();
      try { return raw.run(args, opts); } finally { gitStateMayHaveMoved(); }
    }
    if (at !== generation) { answers.clear(); at = generation; }
    const key = keyOf(args);
    const kept = answers.get(key);
    if (kept && 'err' in kept) throw kept.err;
    // An answer too big for this caller's buffer is asked again, so it fails as it would have.
    if (kept && Buffer.byteLength(kept.out) <= (opts.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER)) return kept.out;
    if (kept) return raw.run(args, opts);
    try {
      // stderr always captured: a kept failure carries it for whoever asks next.
      const out = raw.run(args, { ...opts, stderr: 'pipe' });
      answers.set(key, { out });
      return out;
    } catch (e) {
      if (settled(e)) answers.set(key, { err: e });
      throw e;
    }
  };
  const fence: GitRunner = { run: (args, opts) => (placeOnly(args) || !isReadOnlyGit(args) ? run(args, opts) : raw.run(args, opts)) };
  return { run, fence, raw };
}
