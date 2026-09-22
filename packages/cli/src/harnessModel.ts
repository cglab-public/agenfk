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
function claudeCandidates(home: string, now: number): Candidate[] {
  const root = path.join(home, '.claude', 'projects');
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
 * The session the harness itself says is running, from the environment it
 * gives every tool shell (CGLAB-365).
 *
 * The cwd heuristic below cannot tell two live sessions in ONE repo directory
 * apart, and its mtime tiebreak picks whichever wrote last: a Fable session was
 * "corrected" to claude-opus-5 from a concurrent Opus session's transcript.
 * Both harnesses export the exact identity, so it is read first:
 *   - pi's bash tool sets PI_SESSION_FILE (and PI_SESSION_ID / PI_MODEL);
 *   - Claude Code sets CLAUDE_CODE_SESSION_ID, the transcript's basename under
 *     ~/.claude/projects/<slug>/.
 * Anything that does not resolve to a readable log with a model falls through
 * to the heuristic rather than returning nothing: a missed source is a weaker
 * answer, a refusal is no answer.
 */
function fromEnvironment(home: string, env: NodeJS.ProcessEnv): DetectedModel | null {
  const piFile = env.PI_SESSION_FILE;
  if (typeof piFile === 'string' && piFile && isFile(piFile)) {
    const model = piModelOf(records(piFile));
    if (model) return { model, harness: 'pi', source: piFile };
  }
  const ccId = env.CLAUDE_CODE_SESSION_ID;
  // A plain id only: this value becomes a path component, and the environment
  // is not a trusted place to take one from.
  if (typeof ccId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ccId)) {
    const projects = path.join(home, '.claude', 'projects');
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { /* no Claude Code here */ }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(projects, d.name, `${ccId}.jsonl`);
      if (!isFile(file)) continue;
      const model = claudeModelOf(records(file));
      if (model) return { model, harness: 'claude-code', source: file };
    }
  }
  return null;
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
    const exact = fromEnvironment(home, env);
    if (exact) return exact;
    const best = pick([...piCandidates(home, now), ...claudeCandidates(home, now)], canonicalPath(cwd), now);
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
        `a ${detected.harness} session log in this directory records ${detected.model}, but you `
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
