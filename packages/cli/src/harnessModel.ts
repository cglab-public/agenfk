/**
 * Which model actually ran, read from the harness's own session log.
 *
 * `--model` is a self-report, and self-reports were wrong in the way that
 * matters: a pi session running DeepSeek v4.1 Flash attributed its PR to
 * Qwen 3.8 27b. pi writes a `model_change` record whenever the model is
 * selected — the first is the launch default taken from `settings.json`
 * (`coding4` / `qwen3.8:27b`), and a session that switches writes another. Any
 * reporter reading the default setting, or the first record, credits every such
 * session to a model it never ran, and that lands on the `pr.opened` hub event
 * where PR Overview and the bench work both read it.
 *
 * So the rule is: the LAST model selection is the one that was in force.
 *
 * Detection is best-effort by design. It covers the two harnesses whose logs are
 * on disk in a known shape; anything else returns null and the caller keeps the
 * declared value, so an unknown harness is never blocked from opening a PR.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DetectedModel {
  /** The model id as the harness records it, e.g. `deepseek/deepseek-v4.1-flash`. */
  model: string;
  /** The harness the evidence came from, e.g. `pi`, `claude-code`. */
  harness: string;
  /** The log the value was read from, so a surprising result can be checked. */
  source: string;
}

/** A log file, the directories its session ran in, and how to read its model. */
interface Candidate {
  file: string;
  /**
   * Real absolute paths the session recorded, never a path reconstructed from a
   * directory NAME. Claude Code names its project folders by replacing '/' with
   * '-', which is lossy in both directions: `/work/proj-2` reconstructed to
   * `/work/proj/2` and matched a sibling repo's session, and `/work/my-proj`
   * collided with `/work/my/proj`. Both harnesses record the true cwd in their
   * logs, so that is what is compared.
   */
  cwds: string[];
  mtimeMs: number;
  harness: string;
  readModel: (recs: any[]) => string | null;
}

const canonicalCache = new Map<string, string>();

/** Comparable form of a path: absolute, normalised, no trailing separator. */
function canonicalPath(p: string): string {
  const cached = canonicalCache.get(p);
  if (cached !== undefined) return cached;
  const value = canonicalPathUncached(p);
  canonicalCache.set(p, value);
  return value;
}

function canonicalPathUncached(p: string): string {
  const resolved = path.resolve(p);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Not on disk (a test fixture, or a directory since removed) — the
    // normalised form is still the best comparison we have.
  }
  return real.length > 1 && real.endsWith(path.sep) ? real.slice(0, -1) : real;
}

/**
 * How deep `target` sits under `base`, or -1 when it is not under it at all.
 * Segment-aware, so `/work/proj` is never a prefix of `/work/proj-2`.
 */
function depthUnder(base: string, target: string): number {
  if (base === target) return 0;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!target.startsWith(prefix)) return -1;
  return target.slice(prefix.length).split(path.sep).length;
}

/**
 * How far above a session's directory we will still accept a match.
 *
 * agenfk is routinely run from a package subdirectory of the repo the session
 * started in, so some ancestry has to be allowed — `packages/hub/src` is three
 * below a repo root. Unbounded ancestry must not be: a session started in the
 * home directory is an ancestor of every repo the user owns, and would answer
 * for all of them.
 */
const MAX_ANCESTOR_DEPTH = 3;

/**
 * How old a session log may be and still be taken as "the session running now".
 *
 * A PR is opened from inside a session, so the live log was written moments ago.
 * Without a bound, a machine that once ran pi in a repo would credit every later
 * PR from that repo to whatever pi last used — which is the same class of error
 * as reading a default setting, just with extra steps.
 */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How many leading records establish a session's directories. pi puts its
 * `session` record on line 1; Claude Code stamps `cwd` on essentially every
 * record, so a short head is plenty for both.
 */
const SESSION_HEAD_RECORDS = 20;

/** Read a JSONL file into parsed records, skipping anything unparseable. */
function records(file: string, limit = Infinity): any[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A truncated last line is normal for a session still being written.
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Candidate log files, newest first, with anything already too old to be the
 * running session dropped BEFORE it is read.
 *
 * This is the difference between a command that costs milliseconds and one that
 * costs seconds: a machine accumulates hundreds of session logs forever, and all
 * but the most recent few are irrelevant by definition. Filtering after reading
 * meant parsing ~155 MB on every `agenfk pr create`.
 */
function freshFiles(dir: string, now: number): Array<{ file: string; mtimeMs: number }> {
  const out: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of listFiles(dir)) {
    const m = mtime(file);
    if (now - m > MAX_SESSION_AGE_MS) continue;
    out.push({ file, mtimeMs: m });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function listFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * The best candidate for `cwd`: an exact match, else the session whose cwd is
 * the nearest ancestor. agenfk is routinely run from a package subdirectory
 * while the session was started at the repo root, and refusing to match that
 * would mean detection almost never fires in a monorepo. Ties break on recency.
 */
function pick(candidates: Candidate[], cwd: string, now: number): Candidate | null {
  const scored = candidates
    .map(c => {
      let depth = -1;
      for (const base of c.cwds) {
        const d = depthUnder(base, cwd);
        if (d >= 0 && (depth < 0 || d < depth)) depth = d;
      }
      return { c, depth };
    })
    .filter(s => s.depth >= 0 && s.depth <= MAX_ANCESTOR_DEPTH && now - s.c.mtimeMs <= MAX_SESSION_AGE_MS);
  if (scored.length === 0) return null;
  // Closest directory first, then most recent. Harness is NOT part of the
  // ordering: trying one harness before the other meant a stale pi log in a repo
  // beat the Claude Code session actually running in it.
  scored.sort((a, b) => (a.depth - b.depth) || (b.c.mtimeMs - a.c.mtimeMs));
  return scored[0].c;
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** pi: sessions carry their own cwd, and model selection is a `model_change`. */
function piCandidates(home: string, now: number): Candidate[] {
  const root = path.join(home, '.pi', 'agent', 'sessions');
  const candidates: Candidate[] = [];
  for (const { file, mtimeMs } of freshFiles(root, now)) {
    // The `session` record is the first line, so only the head is read.
    const recs = records(file, SESSION_HEAD_RECORDS);
    const session = recs.find(r => r?.type === 'session' && typeof r.cwd === 'string');
    if (!session) continue;
    candidates.push({
      file, cwds: [canonicalPath(session.cwd)], mtimeMs, harness: 'pi',
      // The LAST selection is the one in force.
      //
      // Reported as pi spells it, with no provider prepended. pi's own ids are
      // already vendor-qualified where it matters (`deepseek/deepseek-v4.1-flash`),
      // and the hub matches on the segment after the LAST slash — so prepending
      // `openrouter/` would push the vendor out of the match key and split the
      // model into its own dashboard group.
      readModel: piModelOf,
    });
  }
  return candidates;
}

/** pi: the LAST model_change is the one in force. */
function piModelOf(rs: any[]): string | null {
  let model: string | null = null;
  for (const r of rs) {
    if (r?.type === 'model_change' && typeof r.modelId === 'string' && r.modelId) model = r.modelId;
  }
  return model;
}

/** Claude Code: the last real model on a non-sidechain assistant turn. */
function claudeModelOf(rs: any[]): string | null {
  let model: string | null = null;
  for (const r of rs) {
    // Assistant turns only, and never a subagent's: a subagent runs a
    // different model from the session that spawned it.
    if (r?.type !== 'assistant' || r?.isSidechain) continue;
    const m = r?.message?.model ?? r?.model;
    // `<synthetic>` is written on cancelled and errored turns. Taking it
    // would replace a correct --model with a non-model string on an
    // append-only event.
    if (typeof m === 'string' && m && !/^<.*>$/.test(m)) model = m;
  }
  return model;
}

/** Claude Code: one directory per project, model recorded on each message. */
function claudeCandidates(home: string, now: number, env: NodeJS.ProcessEnv): Candidate[] {
  const root = claudeProjectsRoot(home, env);
  const candidates: Candidate[] = [];
  for (const { file, mtimeMs } of freshFiles(root, now)) {
    // The transcript records the real cwd, and it can change mid-session, so
    // every distinct value counts as a directory this session worked in.
    const cwds = new Set<string>();
    for (const r of records(file, SESSION_HEAD_RECORDS)) {
      if (typeof r?.cwd === 'string' && r.cwd) cwds.add(canonicalPath(r.cwd));
    }
    if (cwds.size === 0) continue;
    candidates.push({
      file, cwds: [...cwds], mtimeMs, harness: 'claude-code',
      readModel: claudeModelOf,
    });
  }
  return candidates;
}

/**
 * How recently a subagent must have written for the parent's identity to count
 * as ambiguous. A subagent inherits the parent's CLAUDE_CODE_SESSION_ID and can
 * run a different model, so while one is writing, "the session running now"
 * has two candidates and the honest answer is none. Tight on purpose: the
 * subagents directory keeps every past run.
 */
const SUBAGENT_ACTIVE_WINDOW_MS = 5 * 60_000;

/** Model ids are short; anything longer is not one and must not go on the wire. */
const MAX_MODEL_ID_LENGTH = 200;

/** Where Claude Code keeps its transcripts, honouring a relocated config dir. */
function claudeProjectsRoot(home: string, env: NodeJS.ProcessEnv): string {
  const cfg = env.CLAUDE_CONFIG_DIR;
  return path.join(typeof cfg === 'string' && cfg ? cfg : path.join(home, '.claude'), 'projects');
}

/**
 * What the environment settled. `answer` is the model, or null for "the
 * harness named a session and it has no usable answer" — which is final and
 * must NOT fall through to the cwd heuristic, since that heuristic would pick
 * the concurrent sibling this whole path exists to avoid. `undefined` means the
 * environment named nothing usable, and the heuristic may run.
 */
type EnvVerdict = DetectedModel | null | undefined;

/**
 * The session the harness itself says is running, from the environment it
 * gives every tool shell (CGLAB-365).
 *
 * The cwd heuristic cannot tell two live sessions in ONE repo directory apart,
 * and its mtime tiebreak picks whichever wrote last: a Fable session was
 * "corrected" to claude-opus-5 from a concurrent Opus session's transcript.
 * Both harnesses export the exact identity, so it is read first:
 *   - pi's bash tool sets PI_SESSION_FILE and PI_MODEL (the model in force);
 *   - Claude Code sets CLAUDE_CODE_SESSION_ID, the transcript's basename under
 *     <config>/projects/<slug>/.
 *
 * Two things a named session can still get wrong, and how each is handled:
 *   - It may be dead. The variable is inherited by everything spawned from a
 *     tool shell (a tmux server, a detached worker), so a log older than the
 *     freshness bound is a stale identity, not the session running now → null.
 *   - Under Claude Code the SAME id names the parent and every subagent it
 *     spawns, and a subagent may run another model. While a subagent has
 *     written recently the identity is ambiguous → null.
 */
function fromEnvironment(home: string, env: NodeJS.ProcessEnv, now: number): EnvVerdict {
  const pi = fromPiEnvironment(home, env, now);
  if (pi !== undefined) return pi;
  return fromClaudeEnvironment(home, env, now);
}

function fromPiEnvironment(home: string, env: NodeJS.ProcessEnv, now: number): EnvVerdict {
  const file = env.PI_SESSION_FILE;
  const direct = typeof env.PI_MODEL === 'string' && env.PI_MODEL ? env.PI_MODEL : null;
  // Only a log pi itself would have written: its own sessions directory, its
  // own extension. The variable can be set by anything in the shell.
  const sessionsRoot = path.join(home, '.pi', 'agent', 'sessions') + path.sep;
  const named = typeof file === 'string' && file.endsWith('.jsonl') && file.startsWith(sessionsRoot) && isFile(file);
  if (!named && !direct) return undefined;
  if (named) {
    if (now - mtime(file!) > MAX_SESSION_AGE_MS) return null;
    const model = piModelOf(records(file!));
    if (model) return bounded({ model, harness: 'pi', source: file! });
  }
  // The file has no model_change yet (or no file was named): pi also exports
  // the model in force, which is the direct answer the file only derives.
  if (direct) return bounded({ model: direct, harness: 'pi', source: 'env:PI_MODEL' });
  return null;
}

function fromClaudeEnvironment(home: string, env: NodeJS.ProcessEnv, now: number): EnvVerdict {
  const id = env.CLAUDE_CODE_SESSION_ID;
  // A plain id only: this value becomes a path component, and the environment
  // is not a trusted place to take one from.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
  const projects = claudeProjectsRoot(home, env);
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { /* no Claude Code here */ }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projects, d.name, `${id}.jsonl`);
    if (!isFile(file)) continue;
    if (now - mtime(file) > MAX_SESSION_AGE_MS) return null;
    if (subagentActive(path.join(projects, d.name, id, 'subagents'), now)) return null;
    const model = claudeModelOf(records(file));
    return model ? bounded({ model, harness: 'claude-code', source: file }) : null;
  }
  // No transcript by that name anywhere: a relocated or missing config dir,
  // not a session with no answer. The heuristic may still find one.
  return undefined;
}

/** Whether any subagent transcript under this session was written just now. */
function subagentActive(dir: string, now: number): boolean {
  for (const file of listFiles(dir)) {
    if (now - mtime(file) <= SUBAGENT_ACTIVE_WINDOW_MS) return true;
  }
  return false;
}

function bounded(d: DetectedModel): DetectedModel | null {
  return d.model.length <= MAX_MODEL_ID_LENGTH ? d : null;
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * The model the current session is actually running, or null when no harness
 * log can be matched to `cwd`.
 */
export function detectHarnessModel(
  opts: { cwd?: string; home?: string; now?: number; env?: NodeJS.ProcessEnv } = {},
): DetectedModel | null {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  try {
    const verdict = fromEnvironment(home, env, now);
    if (verdict !== undefined) return verdict;
    const best = pick([...piCandidates(home, now), ...claudeCandidates(home, now, env)], canonicalPath(cwd), now);
    if (!best) return null;
    const model = best.readModel(records(best.file));
    return model ? { model, harness: best.harness, source: best.file } : null;
  } catch {
    // Detection is an improvement on a self-report, never a gate on opening a
    // PR. Anything unexpected falls back to what the caller declared.
    return null;
  }
}

export interface ReconciledModel {
  model: string;
  /** Present only when the declaration disagreed with the evidence. */
  warning?: string;
  /**
   * False when no session log could be matched, so the model is the caller's
   * unverified claim. Lets the command say which of the two it reported.
   */
  verified: boolean;
}

/**
 * Settle a declared `--model` against what the session log shows.
 *
 * Evidence wins. A log is what happened; a flag is what an agent believed, and
 * the belief is what was wrong. The override is always announced, never silent,
 * so a detection bug is visible rather than quietly rewriting attribution.
 */
export function reconcileModel(
  declared: string,
  detected: DetectedModel | null,
  declaredHarness?: string,
): ReconciledModel {
  if (!detected) return { model: declared, verified: false };
  if (detected.model === declared) return { model: declared, verified: true };
  // A log from a DIFFERENT harness is evidence about a different session.
  // Rewriting the model but not the harness would write an incoherent pair —
  // a stale pi log relabelling a codex run as qwen.
  if (declaredHarness && detected.harness !== declaredHarness) {
    return {
      model: declared,
      verified: false,
      warning:
        `the ${detected.harness} session log records ${detected.model}, but you `
        + `declared --harness ${declaredHarness}. Keeping your --model ${declared}; the log is from `
        + `another harness. (source: ${detected.source})`,
    };
  }
  return {
    model: detected.model,
    verified: true,
    warning:
      `declared --model ${declared}, but the ${detected.harness} session log records `
      + `${detected.model}. Using the detected value; pass --no-detect-model to keep yours. `
      + `(source: ${detected.source})`,
  };
}

/**
 * What the PR commands call: settle `--model` against the session log unless the
 * caller opted out with `--no-detect-model`.
 */
export function resolveModelForReport(
  declared: string,
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; detect?: boolean; harness?: string } = {},
): ReconciledModel {
  if (opts.detect === false) return { model: declared, verified: false };
  return reconcileModel(declared, detectHarnessModel({ cwd: opts.cwd, home: opts.home, env: opts.env }), opts.harness);
}

/** The option shape the three PR commands parse (commander negates --no-*). */
export interface PrModelOptions {
  model: string;
  harness?: string;
  /** commander sets this false for --no-detect-model, true otherwise. */
  detectModel?: boolean;
}

/**
 * The single step `pr create`, `pr-register` and `pr-resize` each perform.
 *
 * Exists so the option handling — commander's negated flag in particular — is
 * covered by a test rather than by three copies of the same inline expression.
 */
export function resolveFromOptions(
  options: PrModelOptions,
  env: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): ReconciledModel {
  return resolveModelForReport(options.model, {
    cwd: env.cwd,
    home: env.home,
    env: env.env,
    detect: options.detectModel,
    harness: options.harness,
  });
}

/**
 * The session this CLI runs in, as its harness names it (CGLAB-381): the
 * AUTHOR identity `agenfk verify` reports, so a review check can tell an
 * independent reviewer from whoever advanced the card. Read from the variables
 * the harness exports to every tool shell, never from a flag an agent fills in.
 *   - pi: PI_SESSION_FILE, under pi's own sessions folder; the id is the
 *     session header's, which is what a transcript check reads back.
 *   - Claude Code: CLAUDE_CODE_SESSION_ID. A sub-agent inherits it, so a
 *     verify from a sub-agent counts as its parent session's - the cautious
 *     direction for an author identity.
 * Null when neither names a session.
 */
export function harnessActor(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): { client: string; sessionId: string } | null {
  const file = env.PI_SESSION_FILE;
  const piRoot = path.join(home, '.pi', 'agent', 'sessions') + path.sep;
  if (typeof file === 'string' && file.endsWith('.jsonl') && file.startsWith(piRoot) && isFile(file)) {
    const header = records(file, 5).find(r => r && r.type === 'session' && typeof r.id === 'string');
    if (header) return { client: 'pi', sessionId: header.id };
  }
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return { client: 'claude-code', sessionId: id };
  // Codex (BUG e78e78d2): the commands it runs get CODEX_THREAD_ID, the id its
  // transcript's session_meta carries (verified against Codex 0.155.1).
  const thread = env.CODEX_THREAD_ID;
  if (typeof thread === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(thread)) return { client: 'codex', sessionId: thread };
  return null;
}
