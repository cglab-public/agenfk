/**
 * @file GH #312 (parent #310), phase 1 - git spawns on the verify path.
 *
 * On Windows every git spawn costs 100-600 ms, and one verify spawns git dozens
 * of times, mostly the same read-only query again and again. Phase 2 memoises
 * read-only git queries for the duration of ONE verify request (keyed by cwd +
 * args, read-only allowlist only, never across requests) and batches where it
 * can. These specs pin what that must achieve and what it must never break,
 * through child_process alone, so they hold whatever shape the wrapper takes.
 *
 * MEASURED (phase 1, Windows, this file's fixture repo; fixture-building spawns excluded):
 *
 *   BUILD -> TIDY (coding step: check engine, suite capture, tree fences): 29 git spawns, 6 distinct
 *      7  rev-parse --show-prefix                              changedSince / outsideEntries / outsideContent / review range
 *      5  rev-parse HEAD                                       treeContentRead
 *      5  ls-files -z -s                                       treeFiles
 *      5  diff --no-renames --name-only --relative -z          treeFiles
 *      5  ls-files -z --others --exclude-standard              treeFiles
 *      2  status --porcelain                                   checkEngine (porcelain checks) / propagation.readCleanTreeSha
 *   TIDY -> LOOK: 12 git spawns, 6 distinct (the same six, twice each)
 *   LOOK -> FINISHED (close, commit on): 52 git spawns, 23 distinct - the tree quartet
 *      (rev-parse HEAD, ls-files -s, diff, ls-files --others) 6x each, rev-parse --show-prefix 5x,
 *      status --porcelain 6x, then once each: the merge/rebase/cherry-pick state probes
 *      (closeCommit: rev-parse --git-dir, -q --verify MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD,
 *      --git-path rebase-merge/rebase-apply/sequencer), status --porcelain -z, diff --cached
 *      --name-only, commit -m, rev-parse --verify <sha>^{commit}, and the review checks'
 *      remote get-url, for-each-ref, merge-base, log, diff --cached --diff-filter=A, ls-files --others.
 *
 * (51 on this branch when re-measured for the review revision; the earlier 52 was one
 * probe more. Either way the ceilings below sit far under it.)
 *
 * A memo must not swallow a FENCE: the tree is read before and after the suite
 * runs precisely to see whether it moved under the run (de5e5a03), and reads
 * after a git write must see the write. So "within one verify" means within one
 * EPOCH: the stretch between two state-changing events, which are any non-git
 * child (the suite, a command check) - its START and, for an async child, its
 * EXIT, since what it wrote is only all there once it has exited - and any git
 * command not on the read-only allowlist below. The memo the specs ask for is
 * per epoch; across epochs the query runs again.
 *
 * DELIBERATE FENCE RE-READS (Holden's review). Several agents share ONE worktree
 * (MULTI_AGENT.md), so the server re-reads on purpose, inside one epoch, to catch
 * ANOTHER agent writing between two of its own reads. A memo must answer those
 * re-reads from git, never from the first read. The sites:
 *   F1 closeGreenOnRecord (server.ts, "HEAD read again after the files"): readCleanTreeSha
 *      (`status --porcelain`, then `rev-parse HEAD` when the tree is clean), treeFiles, then
 *      readCleanTreeSha again - "a commit between the two reads would tie this content to
 *      the wrong commit". On the closing verify measured here the tree is dirty (the card's
 *      work is staged, not committed), so each read stops at `status --porcelain`: the
 *      re-read is ONE extra `status --porcelain`.
 *   F3 the close's "green of this tree on record" branch (server.ts, validate handler, right after
 *      `closeGreenOnRecord(...)`: `if (onRecord && treeStateOf(effectiveRoot!, project) === onRecord.state)`,
 *      "The state it matched, still the tree's: a tree that moved since runs the command").
 *      closeGreenOnRecord read the tree, then awaited reusableCapture (indexProjectGreens, storage
 *      reads); F3 reads it again so an edit landing in those awaits is run, not closed on an older
 *      green. Nothing between the two spawns a non-git child or a git write, so both reads fall in
 *      ONE epoch. treeStateOf = treeFiles + outsideContent; measured (SPAWN_DUMP, stack-tagged) the
 *      re-read is `ls-files -z -s`, `diff --no-renames --name-only --relative -z` and
 *      `ls-files -z --others --exclude-standard`, one extra each. outsideContent's
 *      `rev-parse --show-prefix` repeats too but is NOT excused: it names where the root sits in the
 *      repository, which no write by another agent can move, so a memo may answer it. (On a
 *      subdirectory project outsideContent goes on to read HEAD, `ls-tree` and what lies beside
 *      the root: those ARE part of F3 there; this fixture's root project stops at the prefix.)
 *      (f) pins that F3 still SEES an edit landing after closeGreenOnRecord's read.
 *   F2 runCommandAndFinalize (server.ts): headBeforeRun/statusBeforeRun (readHead +
 *      readTreeStatus) against preCommitSha/preCommitStatus, giving treeStoodStill. It needs
 *      no allowance: the verify command's own spawn always lies between the two pairs, so
 *      they are never in one epoch. And the measured close does not reach it at all - it
 *      closes on the green on record (closeOnGreen), which is why the dump shows no
 *      `diff --cached --raw` (readTreeStatus always issues one).
 *   F4 stampCloseGreen (server.ts, called from closeOnGreen's stampAt branch once the close
 *      commit has run - in (g) the tree is already clean and the commit is skipped, under
 *      Vitest too; the closeOnGreen -> stampCloseGreen window is the same): closeOnGreen
 *      reads readCleanTreeSha + treeStateOf to stamp the green with
 *      the commit, awaits storage (getItem, updateItem), then stampCloseGreen reads them again:
 *      readCleanTreeSha (`status --porcelain`, then `rev-parse HEAD`, the tree being clean after
 *      the commit) and treeFilesState (`ls-files -z -s`, `diff --no-renames --name-only --relative -z`,
 *      `ls-files -z --others --exclude-standard`) - its doc's guard against "another agent
 *      committing in between". Holden ruled it a deliberate fence: those 5 re-reads, one extra
 *      each, are excused in the epoch AFTER the close commit only; before the commit they are not,
 *      and a memo must still collapse them there. outsideContent's `rev-parse --show-prefix`
 *      repeats here too and stays un-excused (the reason given under F3; Holden confirmed).
 *      Measured (SPAWN_DUMP): the post-commit epoch has 13 reads, 7 distinct = 7 + 5 (F4) + 1
 *      repeated `rev-parse --show-prefix`. (g) pins that F4 still SEES another agent's commit.
 * (b) allows exactly F1 + F3 in the epochs before the close commit and F4 in the epoch it opens
 * (FENCE_REREADS.close, keyed by the epoch's place relative to the git write), and nothing on the
 * coding step. The fence tests pin that each still SEES a write: (e) F1, (f) F3, (g) F4.
 *
 * FOR PHASE 2 (Holden's notes, recorded so they travel with the spec):
 *  - an epoch ends at a non-git child's exit as well as its start (the spy below marks both);
 *  - the memo caches an OUTCOME, non-zero exits and stderr included: closeCommit's
 *    `rev-parse -q --verify MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD` probes exit 1 when the
 *    ref is absent, and a memo that caches only successes re-spawns them, or worse turns a
 *    throw into a cached '' that reads as "present";
 *  - an in-flight async read is shared as ONE promise, so two awaits of the same query in
 *    one epoch spawn once.
 * No spec pins the non-zero-exit point yet: each probe runs once per close today, so a
 * memo that mishandled it would still pass every count here, and the probe outcomes
 * themselves are pinned by auto-git-commit-scope.test.ts. A deterministic spec for it needs
 * a path that asks the same failing probe twice in one epoch, which none does now.
 *
 * The close commit is skipped under vitest (server.ts gates autoGitCommit on
 * NODE_ENV/VITEST); the close spec lifts that gate for the one request it
 * measures, so the commit really runs inside the verify.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

type Spawn = { fn: string; git: boolean; cwd: string; args: string[]; line: string; exit?: true };
const rec = vi.hoisted(() => ({
  on: false,
  calls: [] as any[],
  /** The unwrapped module, so a spec can act as ANOTHER agent without being recorded. */
  real: null as null | typeof import('child_process'),
  /** Called before each git spawn while recording, on the spawn about to run. */
  beforeGit: null as null | ((s: any) => void),
}));

/*
 * Every child process goes through the recorder, whichever specifier the server
 * (or a phase-2 wrapper) imports: `child_process` or `node:child_process`. A
 * wrapper importing the other one must not slip past the counts.
 */
const recordChildProcess = vi.hoisted(() => async (importOriginal: () => Promise<unknown>) => {
  const real = (await importOriginal()) as typeof import('child_process');
  rec.real = real;
  const optionsOf = (a: unknown[]) => a.find(x => typeof x === 'object' && x !== null && !Array.isArray(x)) as { cwd?: unknown } | undefined;
  const wrap = (fn: 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'spawn' | 'spawnSync' | 'fork') => ((...a: unknown[]) => {
    let seen: Spawn | null = null;
    if (rec.on) {
      // A shell string (exec/execSync, or spawn with shell) is split on blanks: enough to tell git from not-git.
      const shell = fn === 'exec' || fn === 'execSync' || !Array.isArray(a[1]);
      const words = shell ? String(a[0]).trim().split(/\s+/) : [String(a[0]), ...(a[1] as unknown[]).map(String)];
      let [file, ...args] = words;
      let cwd = String(optionsOf(a)?.cwd ?? '');
      const git = fn !== 'fork' && /(^|[\\/])git(\.exe)?$/i.test(file);
      if (git) { while (args[0] === '-C') { cwd = args[1]; args = args.slice(2); } }
      seen = { fn, git, cwd: cwd.replace(/\\/g, '/'), args, line: words.join(' ') };
      rec.calls.push(seen);
      if (git && rec.beforeGit) rec.beforeGit(seen);
    }
    const out = (real[fn] as (...x: unknown[]) => unknown)(...a);
    // An async non-git child ends its epoch twice: when it starts and when it exits (what it wrote is all there only then).
    if (seen && !seen.git && (fn === 'exec' || fn === 'execFile' || fn === 'spawn' || fn === 'fork')) {
      const marker: Spawn = { ...seen, exit: true };
      (out as { once?: (e: string, f: () => void) => void })?.once?.('exit', () => { if (rec.on) rec.calls.push(marker); });
    }
    return out;
  }) as never;
  const w = { exec: wrap('exec'), execSync: wrap('execSync'), execFile: wrap('execFile'), execFileSync: wrap('execFileSync'), spawn: wrap('spawn'), spawnSync: wrap('spawnSync'), fork: wrap('fork') };
  return { ...real, ...w, default: { ...real, ...w } };
});
vi.mock('child_process', (importOriginal) => recordChildProcess(importOriginal));
vi.mock('node:child_process', (importOriginal) => recordChildProcess(importOriginal));

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

import { execSync } from 'child_process';
import { posixShell } from './helpers/posixShell';
import { AUTHOR, atBuild, atLook, impl, item, lines, reviewed, reviewerBegins, useEngineServer, validate, write } from './helpers/engineTests';

useEngineServer('verify-git-spawns-test-db.sqlite');

/** Every spawn made while `f` runs - and only those: the fixture's own spawns are outside the window. */
async function spawnsDuring<T>(f: () => Promise<T>): Promise<{ out: T; spawns: Spawn[] }> {
  rec.calls = [];
  rec.on = true;
  try { return { out: await f(), spawns: rec.calls.slice() as Spawn[] }; } finally { rec.on = false; }
}
const gitOf = (s: Spawn[]) => s.filter(x => x.git);

/** The git subcommand, past the global options (-c k=v, --no-pager, ...). */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') { i++; continue; }
    if (!args[i].startsWith('-')) return args[i];
  }
  return '';
}
/**
 * Queries that only read. Phase 2's memo may answer these; everything else is a
 * write (or not known not to be), always runs, and ends the epoch.
 */
const READ_ONLY = new Set(['rev-parse', 'status', 'ls-files', 'diff', 'log', 'show', 'merge-base', 'for-each-ref', 'cat-file', 'rev-list', 'check-ignore', 'ls-tree', 'describe', 'name-rev', 'symbolic-ref', 'diff-index', 'diff-files', 'diff-tree', 'show-ref']);
function readOnly(s: Spawn): boolean {
  const sub = subcommand(s.args);
  if (sub === 'remote') return s.args.includes('get-url') || s.args.length === 1;
  if (sub === 'config') return s.args.some(a => a === '--get' || a === '--get-all' || a === '--list' || a === '-l');
  return READ_ONLY.has(sub);
}
const keyOf = (s: Spawn) => `${s.cwd} :: ${s.args.join(' ')}`;

/**
 * The deliberate fence re-reads one verify may repeat inside an epoch, per query
 * (git args), as extra runs on top of the first. Named and minimal: each entry is
 * a site in the header's DELIBERATE FENCE RE-READS, and nothing else is excused.
 * Keyed by where the epoch sits relative to the verify's git write: `beforeWrite`
 * holds for every epoch before the first git write, `afterWrite` for the ONE epoch
 * that write opens, and any other epoch is allowed nothing. One table for every
 * epoch would let F4's `rev-parse HEAD` excuse a pre-commit repeat the memo must collapse.
 */
type FenceAllowance = { beforeWrite?: Record<string, number>; afterWrite?: Record<string, number> };
const FENCE_REREADS: { coding: FenceAllowance; close: FenceAllowance } = {
  /** BUILD -> TIDY: none. Its only fence (the suite capture's before/after reads) spans the suite, so two epochs. */
  coding: {},
  close: {
    /**
     * Before the close commit: F1's second readCleanTreeSha, on a dirty tree just its `status --porcelain`;
     * F3's treeStateOf, its treeFiles trio (not outsideContent's `rev-parse --show-prefix`: see the header).
     */
    beforeWrite: {
      'status --porcelain': 1, // F1
      'ls-files -z -s': 1, // F3
      'diff --no-renames --name-only --relative -z': 1, // F3
      'ls-files -z --others --exclude-standard': 1, // F3
    },
    /** The epoch the close commit opens: F4, stampCloseGreen's readCleanTreeSha (the tree clean now) + treeFilesState. */
    afterWrite: {
      'status --porcelain': 1, // F4
      'rev-parse HEAD': 1, // F4
      'ls-files -z -s': 1, // F4
      'diff --no-renames --name-only --relative -z': 1, // F4
      'ls-files -z --others --exclude-standard': 1, // F4
    },
  },
};

/**
 * The spawns cut into epochs: a non-git spawn or a git write closes one (and belongs to none).
 * Each with its place: 'before' any git write, 'after' (the one the first git write opens), or 'other'.
 */
function placedEpochs(spawns: Spawn[]): { at: 'before' | 'after' | 'other'; spawns: Spawn[] }[] {
  let wrote = false;
  let cur: { at: 'before' | 'after' | 'other'; spawns: Spawn[] } = { at: 'before', spawns: [] };
  const all = [cur];
  for (const s of spawns) {
    if (s.git && readOnly(s)) { cur.spawns.push(s); continue; }
    const at = wrote ? 'other' : s.git ? 'after' : 'before';
    if (s.git) wrote = true;
    all.push(cur = { at, spawns: [] });
  }
  return all.filter(e => e.spawns.length);
}

/** Read-only git queries run more than once inside one epoch (beyond the fence re-reads allowed there), with their counts. */
function duplicatesWithinAnEpoch(spawns: Spawn[], fenceRereads: FenceAllowance = {}): Record<string, number> {
  const dup: Record<string, number> = {};
  for (const { at, spawns: e } of placedEpochs(spawns)) {
    const allowed = (at === 'before' ? fenceRereads.beforeWrite : at === 'after' ? fenceRereads.afterWrite : undefined) ?? {};
    const n = new Map<string, { c: number; args: string }>();
    for (const s of e) n.set(keyOf(s), { c: (n.get(keyOf(s))?.c ?? 0) + 1, args: s.args.join(' ') });
    for (const [k, { c, args }] of n) if (c > 1 + (allowed[args] ?? 0)) dup[k] = Math.max(dup[k] ?? 0, c);
  }
  return dup;
}
const isSuite = (s: Spawn) => !s.git && !s.exit && /runner\.cjs/.test(s.line);

/** Optional measurement dump (SPAWN_DUMP=<file>): the phase-2 before/after numbers come from here. */
const dump = (name: string, spawns: Spawn[]) => {
  if (process.env.SPAWN_DUMP) fs.appendFileSync(process.env.SPAWN_DUMP, JSON.stringify({ name, spawns }) + '\n');
};

/** The final verify with the close commit on: the vitest gate lifted for this one request only. */
async function closeWithCommit(id: string) {
  const saved = { vitest: process.env.VITEST, nodeEnv: process.env.NODE_ENV };
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  try { return await validate(id, AUTHOR); } finally {
    if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
    if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv;
  }
}
const head = (dir: string) => execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
const commitsIn = (dir: string) => Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim());

/** A card at BUILD whose code is now written: the next verify leaves a coding step, green. */
async function readyToLeaveBuild() {
  const at = await atBuild();
  impl(at.dir, { add: 'ok', mul: '12' });
  return at;
}

describe('GH #312: git spawns per verify', () => {
  /*
   * Ceilings, not targets. Today: BUILD -> TIDY 29, close 51-52. What the per-epoch
   * memo alone leaves, re-measured from the SPAWN_DUMP of both moves (each epoch's
   * distinct read-only queries, plus the writes, plus the fence re-reads that must
   * still run):
   *   BUILD -> TIDY: 23 reads / 6 distinct before the suite + 6 / 5 after it = 11,
   *     no write, no fence re-read in one epoch (the capture's fence spans the suite)  -> 11, ceiling 12;
   *   close: 37 reads / 20 distinct before the commit + the commit itself (1)
   *     + 13 / 7 after it = 28, plus the fence re-reads kept live: before the commit
   *     F1 (1: `status --porcelain`, the tree being dirty) and F3 (3: treeStateOf's
   *     `ls-files -z -s`, `diff --no-renames --name-only --relative -z`,
   *     `ls-files -z --others --exclude-standard`; its `rev-parse --show-prefix` is
   *     memoisable); after it F4 (5: stampCloseGreen's `status --porcelain`,
   *     `rev-parse HEAD` and the treeFiles trio; `rev-parse --show-prefix` again
   *     memoisable)                                -> 28 + 1 + 3 + 5 = 37, ceiling 37.
   * The old "27 from the memo alone" did not count the commit nor any fence; F1 on a
   * CLEAN tree would add `rev-parse HEAD` too (+2 in all), which this close does not
   * exercise. No slack is given on the close: batching is where the headroom comes from
   * (one tree read shared by treeContentRead / treeStateOf / suiteStateOf callers;
   * `status --porcelain` and `-z` as one; the two `ls-files --others` spellings as
   * one; closeCommit's seven rev-parse state probes in one or two). Both stay far
   * below today. Raise a ceiling only with a measurement that says why.
   */
  const CODING_STEP_CEILING = 12;
  const CLOSE_CEILING = 37;

  describe('(a) a ceiling on git spawns', () => {
    it(`a coding-step verify (BUILD -> TIDY) spawns git at most ${CODING_STEP_CEILING} times (29 today)`, async () => {
      const { id } = await readyToLeaveBuild();
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
      dump('BUILD->TIDY', spawns);
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const git = gitOf(spawns);
      expect(git.length, git.map(s => s.args.join(' ')).join('\n')).toBeLessThanOrEqual(CODING_STEP_CEILING);
    }, 300_000);

    it(`the closing verify (LOOK -> FINISHED, commit on) spawns git at most ${CLOSE_CEILING} times (51-52 today)`, async () => {
      const { id, dir } = await atLook(3);
      await reviewed(id, dir, { startedAt: await reviewerBegins() });
      execSync('git add -A', { cwd: dir, shell: posixShell() });
      const { out, spawns } = await spawnsDuring(() => closeWithCommit(id));
      dump('LOOK->FINISHED', spawns);
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const git = gitOf(spawns);
      expect(git.length, git.map(s => s.args.join(' ')).join('\n')).toBeLessThanOrEqual(CLOSE_CEILING);
    }, 300_000);
  });

  describe('(b) a read-only query runs once per epoch of one verify', () => {
    it('leaving a coding step repeats no read-only git query between two state changes', async () => {
      const { id } = await readyToLeaveBuild();
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(duplicatesWithinAnEpoch(spawns, FENCE_REREADS.coding)).toEqual({});
    }, 300_000);

    it('the closing verify repeats no read-only git query between two state changes, but for the named fence re-reads', async () => {
      const { id, dir } = await atLook(3);
      await reviewed(id, dir, { startedAt: await reviewerBegins() });
      execSync('git add -A', { cwd: dir, shell: posixShell() });
      const { out, spawns } = await spawnsDuring(() => closeWithCommit(id));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(duplicatesWithinAnEpoch(spawns, FENCE_REREADS.close)).toEqual({});
    }, 300_000);

    it('the fence stands: when the suite runs inside the verify, the tree is read again after it', async () => {
      const { id } = await readyToLeaveBuild();
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const suite = spawns.findIndex(isSuite);
      expect(suite, 'the suite ran inside this verify').toBeGreaterThanOrEqual(0);
      const treeRead = (s: Spawn) => s.git && subcommand(s.args) === 'ls-files' && s.args.includes('-s');
      expect(spawns.slice(0, suite).some(treeRead), 'a tree read before the run').toBe(true);
      expect(spawns.slice(suite + 1).some(treeRead), 'a tree read after the run').toBe(true);
    }, 300_000);
  });

  describe('(c) nothing carries over from one verify to the next', () => {
    it('a working-tree change between two verifies is seen: the green is not reused and the red refuses', async () => {
      const { id, dir } = await readyToLeaveBuild();
      expect((await validate(id, AUTHOR)).status).toBe(200); // BUILD -> TIDY, green
      impl(dir, { add: 'ok', mul: 'broken' });
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR)); // TIDY -> LOOK
      expect(spawns.some(isSuite), 'the changed tree is run, not matched to the earlier green').toBe(true);
      expect(out.status, JSON.stringify(out.body)).toBe(422);
      expect((await item(id)).status).toBe('TIDY');
    }, 300_000);

    it('a commit between two verifies is seen: the green is not reused and the red refuses', async () => {
      const { id, dir } = await readyToLeaveBuild();
      expect((await validate(id, AUTHOR)).status).toBe(200); // BUILD -> TIDY, green
      impl(dir, { add: 'ok', mul: 'broken' });
      execSync('git add -A && git commit -qm "break it"', { cwd: dir, shell: posixShell() });
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR)); // TIDY -> LOOK
      expect(spawns.some(isSuite), 'the new HEAD is run, not matched to the earlier green').toBe(true);
      expect(out.status, JSON.stringify(out.body)).toBe(422);
      expect((await item(id)).status).toBe('TIDY');
    }, 300_000);
  });

  describe('(d) a git write is never memoised', () => {
    it('every write the closing verify issues reaches git, and what it reads afterwards sees it', async () => {
      const { id, dir } = await atLook(3);
      await reviewed(id, dir, { startedAt: await reviewerBegins() });
      execSync('git add -A', { cwd: dir, shell: posixShell() });
      const before = { head: head(dir), commits: commitsIn(dir) };
      const { out, spawns } = await spawnsDuring(() => closeWithCommit(id));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const writes = gitOf(spawns).filter(s => !readOnly(s));
      const commits = writes.filter(s => subcommand(s.args) === 'commit');
      // One commit spawned, one commit made: a write answered from a memo would leave the log short.
      expect(commits.length).toBe(1);
      expect(commitsIn(dir)).toBe(before.commits + 1);
      expect(execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' })).toMatch(/^close\(task\)/);
      expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
      // Reads after the write see it. The close stamps the green it closed on with the commit it made
      // (readCleanTreeSha: a clean tree, and its HEAD): a pre-commit answer kept past the commit would
      // stamp the old HEAD, or none at all, since the tree was not clean before it.
      const after = head(dir);
      expect(after).not.toBe(before.head);
      const tests = (await item(id)).tests as { commit?: string }[];
      expect(tests[tests.length - 1]?.commit).toBe(after);
    }, 300_000);
  });

  /*
   * F1 (header): closeGreenOnRecord reads HEAD, then the tree's content, then HEAD
   * again, so a commit landing between the reads cannot tie this content's green to
   * a commit it was not read at. The fence only bites on a CLEAN tree (on a dirty one
   * readCleanTreeSha is null both times), so these close with the card's work
   * committed, a green of that content on record from LOOK, and no close commit.
   */
  /** A card at LOOK with its work committed (a clean tree) and reviewed: the close may stand on the green on record. */
  async function atCleanLook() {
    const at = await atLook(3);
    execSync('git add -A && git commit -qm "the card\'s work"', { cwd: at.dir, shell: posixShell() });
    await reviewed(at.id, at.dir, { startedAt: await reviewerBegins() });
    return at;
  }
  const lastTest = async (id: string) => { const t = (await item(id)).tests as { output?: string; commit?: string }[]; return t[t.length - 1]; };
  /** The server's call stack at a spawn, deep enough to reach the verify handler. */
  const stackNow = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 200;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    return stack;
  };

  describe('(e) the fence re-read in closeGreenOnRecord still sees another agent', () => {
    it('control: with nobody else writing, the close stands on the green on record and runs nothing', async () => {
      const { id, dir } = await atCleanLook();
      const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(out.body.output, 'the close reused the green of this content (without it, (e) proves nothing)').toBe('Green on record');
      expect(spawns.some(isSuite), 'nothing ran').toBe(false);
      expect((await lastTest(id))?.commit).toBe(head(dir));
    }, 300_000);

    it('another agent committing between the two fence reads: the green on record is not reused, the command runs', async () => {
      const { id, dir } = await atCleanLook();
      /*
       * The other agent: an EMPTY commit (HEAD moves, content does not, so only the
       * HEAD fence can tell) before every git spawn made while closeGreenOnRecord is
       * inside readCleanTreeSha or treeFiles - the fence's span, found by the call
       * stack, so it lands between the two reads whatever a memo answers. A memo
       * that answers the re-read spawns nothing there, the two HEADs agree, the
       * green is reused: red. A memo that answers the FIRST read but runs the
       * re-read still sees the commit made just before it: green.
       * If this goes red after a rename of those functions, re-point the names;
       * never drop the spec.
       */
      let injected = 0;
      rec.beforeGit = (s: Spawn) => {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 200;
        const stack = new Error().stack ?? '';
        Error.stackTraceLimit = limit;
        if (!/\bcloseGreenOnRecord\b/.test(stack) || !/\b(readCleanTreeSha|treeFiles)\b/.test(stack)) return;
        rec.real!.execFileSync('git', ['-C', s.cwd || dir, '-c', 'user.name=other', '-c', 'user.email=other@agent', 'commit', '--allow-empty', '-qm', 'another agent'], { stdio: 'ignore', windowsHide: true });
        injected++;
      };
      try {
        const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
        expect(injected, 'the fence spawned git (a memoised fence spawns none, and the other agent never gets in)').toBeGreaterThan(0);
        expect(out.status, JSON.stringify(out.body)).toBe(200);
        expect(out.body.output, 'the green on record was not reused across the moved HEAD').not.toBe('Green on record');
        expect(spawns.some(isSuite), 'the command ran on the tree as it now is').toBe(true);
        // What the close records is tied to the HEAD the command really ran at, not the one read before the other agent's commit.
        expect((await lastTest(id))?.commit).toBe(head(dir));
      } finally {
        rec.beforeGit = null;
      }
    }, 300_000);
  });

  /*
   * F3 (header): after closeGreenOnRecord matched a green to the tree's state, the
   * close reads the state again (treeStateOf) before closing on it, so an edit that
   * landed during closeGreenOnRecord's awaits is run, not closed on an older green.
   * The control is (e)'s: this same clean-tree close stands on 'Green on record'.
   */
  describe('(f) the fence re-read after closeGreenOnRecord (F3) still sees another agent', () => {
    it('another agent editing a file after closeGreenOnRecord read the tree: the green on record is not reused, the command runs', async () => {
      const { id, dir } = await atCleanLook();
      /*
       * The other agent: a CONTENT change (treeStateOf hashes content, not HEAD), made
       * before the first git spawn whose stack is in treeStateOf but in neither
       * closeGreenOnRecord (its own read, which must see the old tree) nor closeOnGreen
       * (its stampAt re-reads treeStateOf after the commit) nor siblingGreenOf (which
       * reads treeStateOf earlier in the close), and only once closeGreenOnRecord has
       * read: that is F3's window, and nothing else. A memo that answers F3 from
       * closeGreenOnRecord's read spawns nothing there, the other agent never gets in
       * and the injection count stays 0: red. Were the edit made anyway, a memoised F3
       * matches the old state and closes on 'Green on record': red too.
       * If this goes red after a rename of those functions, re-point the names; never
       * drop the spec.
       */
      let recordRead = false;
      let injected = 0;
      rec.beforeGit = () => {
        if (injected) return;
        const stack = stackNow();
        if (/\bcloseGreenOnRecord\b/.test(stack)) { recordRead = true; return; }
        if (!recordRead || !/\btreeStateOf\b/.test(stack) || /\b(closeOnGreen|siblingGreenOf)\b/.test(stack)) return;
        write(dir, 'src/feature.js', lines(4, 'feature')); // atLook(3) wrote 3 lines: the content moves
        injected++;
      };
      try {
        const { out, spawns } = await spawnsDuring(() => validate(id, AUTHOR));
        expect(injected, 'F3 spawned git after closeGreenOnRecord (a memoised F3 spawns none, and the other agent never gets in)').toBe(1);
        expect(out.status, JSON.stringify(out.body)).toBe(200);
        expect(out.body.output, 'the green on record was not reused across the edited content').not.toBe('Green on record');
        expect(spawns.some(isSuite), 'the command ran on the tree as it now is').toBe(true);
      } finally {
        rec.beforeGit = null;
      }
    }, 300_000);
  });

  /*
   * F4 (header): once the close has moved HEAD (here the tree is already clean and the
   * commit is skipped; the closeOnGreen -> stampCloseGreen window is the same),
   * closeOnGreen reads the clean tree's sha and state to stamp the green with that
   * commit, awaits storage, and then
   * stampCloseGreen reads both again before re-stamping the card's last green as a
   * green of that commit (a stepRecord carrying `stampedFrom`): "another agent
   * committing in between is a different commit". The clean-tree close of (e)
   * closes on 'Green on record' through closeOnGreen, so it reaches F4.
   */
  const stampedRecords = async (id: string) => ((await item(id)).stepRecords ?? []).filter((r: any) => r.stampedFrom);

  describe('(g) the fence re-read in stampCloseGreen (F4) still sees another agent', () => {
    it('control: with nobody else writing, the close re-stamps its green as a green of the commit it closed at', async () => {
      const { id, dir } = await atCleanLook();
      const { out } = await spawnsDuring(() => validate(id, AUTHOR));
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(out.body.output, 'the close went through closeOnGreen (without it, (g) proves nothing)').toBe('Green on record');
      const stamped = await stampedRecords(id);
      expect(stamped.length, 'stampCloseGreen stamped the green (without it, (g) proves nothing)').toBe(1);
      expect(stamped[0].head).toBe(head(dir));
    }, 300_000);

    it('another agent committing after closeOnGreen read the tree: stampCloseGreen stamps nothing', async () => {
      const { id, dir } = await atCleanLook();
      /*
       * The other agent: an EMPTY commit (HEAD moves, content does not, so only the
       * HEAD read can tell), made before the first git spawn whose stack is in
       * stampCloseGreen - after closeOnGreen read the sha it hands over, so that sha
       * is now stale. stampCloseGreen's readCleanTreeSha reads the new HEAD, which is
       * not the sha it was given, and it returns null: no `stampedFrom` record. A memo
       * that answers F4 from closeOnGreen's reads spawns nothing in stampCloseGreen,
       * the other agent never gets in and the injection count stays 0: red. Were the
       * commit made anyway, a memoised F4 hands back the old HEAD, the shas agree and
       * a green is stamped on a commit the tree no longer sits at: red too.
       * If this goes red after a rename of that function, re-point the name; never
       * drop the spec.
       */
      let injected = 0;
      rec.beforeGit = (s: Spawn) => {
        if (injected || !/\bstampCloseGreen\b/.test(stackNow())) return;
        rec.real!.execFileSync('git', ['-C', s.cwd || dir, '-c', 'user.name=other', '-c', 'user.email=other@agent', 'commit', '--allow-empty', '-qm', 'another agent'], { stdio: 'ignore', windowsHide: true });
        injected++;
      };
      try {
        const { out } = await spawnsDuring(() => validate(id, AUTHOR));
        expect(injected, 'F4 spawned git in stampCloseGreen (a memoised F4 spawns none, and the other agent never gets in)').toBe(1);
        expect(out.status, JSON.stringify(out.body)).toBe(200);
        expect(out.body.output, 'the close went through closeOnGreen, as in the control').toBe('Green on record');
        expect(await stampedRecords(id), 'no green stamped on a commit the tree no longer sits at').toEqual([]);
      } finally {
        rec.beforeGit = null;
      }
    }, 300_000);
  });
});
