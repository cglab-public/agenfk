#!/usr/bin/env node
/**
 * AgEnFK run recorder (CGLAB-177).
 *
 * Claude Code writes no session transcript the server can tail — unlike the pi
 * worker, which the runs pipeline was built around — so its runs never showed
 * up on a card. This hook pushes them the other way: it opens a run on the
 * first recorded tool call and posts an event per call thereafter, using the
 * generic endpoints that already exist. No second parser, and no dependency on
 * pi being installed.
 *
 * Two rules it lives by:
 *
 *  - It NEVER blocks. Every failure path exits 0 in silence. A recorder that
 *    can break a tool call is worse than no recorder, and a hook's stderr is
 *    somewhere nobody looks.
 *  - It NEVER records file contents. It sees every tool input, and those
 *    routinely carry tokens and keys; only paths, commands and descriptions
 *    are stored. The mapping that enforces this is tested in
 *    packages/server/src/agent-runs/claude-events.ts.
 *
 * Usage in client config: `agenfk-run-hook --client claude-code`
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, lstatSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve, isAbsolute, relative, basename, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

const AGENFK_DIR = join(homedir(), '.agenfk');
const PORT_FILE = join(AGENFK_DIR, 'server-port');
/** Session → runId, so one session appends to one run instead of opening many. */
const RUN_MAP = join(AGENFK_DIR, 'claude-runs.json');

const clientArgIndex = process.argv.indexOf('--client');
const CLIENT = clientArgIndex > -1 ? process.argv[clientArgIndex + 1] : 'claude-code';

/** Read stdin fully. Hooks receive their payload there. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function apiBase() {
  try {
    const port = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch { /* fall through */ }
  return 'http://127.0.0.1:3000';
}

async function api(path, init) {
  // A short deadline on every call: the hook runs between the agent and its
  // tool, so a slow or wedged server must cost milliseconds, not the session.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    // The STATUS is reported back, not just success/failure. A 404 on an
    // event means the run this session cached no longer exists — a reset
    // database, a restored backup — and the caller has to be able to tell
    // that apart from "the server is down", because the fix is different:
    // forget the cached id and open a new run, rather than give up.
    if (!res.ok) return { __status: res.status };
    const body = await res.json().catch(() => ({}));
    return { ...body, __status: res.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readRunMap() {
  try {
    const parsed = JSON.parse(readFileSync(RUN_MAP, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Drop a cached run id.
 *
 * Called when the server says the run is gone. Without this the entry lives
 * forever: every subsequent event for that session POSTs to a run that does
 * not exist, gets a 404, is discarded — and the session silently stops
 * recording anything at all until the process restarts. Silently is the part
 * that matters; nothing surfaces.
 */
function forgetRun(sessionId) {
  try {
    const map = readRunMap();
    if (!(sessionId in map)) return;
    delete map[sessionId];
    const tmp = `${RUN_MAP}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map), 'utf8');
    renameSync(tmp, RUN_MAP);
  } catch { /* a stale entry costs one more 404, not a broken session */ }
}

function rememberRun(sessionId, runId) {
  try {
    mkdirSync(dirname(RUN_MAP), { recursive: true });
    const map = readRunMap();
    map[sessionId] = runId;
    // Keep it small: this file is a cache, not a record. Without a cap it
    // grows by one entry per session forever.
    const entries = Object.entries(map).slice(-50);
    // Write-then-rename: writeFileSync is not atomic and PostToolUse fires
    // concurrently, so a reader can otherwise catch a half-written file, parse
    // it as {}, and open a fresh run for every single tool call.
    const tmp = `${RUN_MAP}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    renameSync(tmp, RUN_MAP);
  } catch { /* a lost cache costs a duplicate run, not a broken session */ }
}

/**
 * The project that owns a cwd: the nearest `.agenfk` holding local.json or
 * project.json. The id comes from local.json (this machine's, git-ignored -
 * CGLAB-625), else a legacy projectId still in project.json: the resolution
 * core's resolveProjectIdentity makes, mirrored because a hook is a
 * standalone script.
 *
 * Null when no project owns the directory - a bare worktree, a temp dir -
 * which is NOT the same as "a different project" and must not be treated as
 * one. A project not linked on this machine is null too, and stops the walk:
 * an outer project's id is not this one's.
 */
export function projectIdFromCwd(cwd) {
  const start = cwd && isAbsolute(cwd) ? cwd : resolve(cwd || '.');
  const found = nearestProject(start);
  const wt = linkedWorktreeOf(start);
  // A marker inside the worktree that names an id settles it; one above the
  // worktree belongs to an enclosing directory, not to this checkout.
  const ownMarker = !!found && !!wt && within(found.root, wt.top);
  if (!wt || (ownMarker && found.projectId)) return found ? found.projectId : null;
  // local.json is git-ignored, so a worktree has none: the main checkout's answers.
  const there = nearestProject(join(wt.main, relative(wt.top, ownMarker ? found.root : start)));
  if (there && there.projectId && within(there.root, wt.main)) return there.projectId;
  return found ? found.projectId : null;
}

/** A small regular file's text, or null: a FIFO would block a sync read for ever. */
function readSmall(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

function idIn(text) {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.projectId === 'string' && parsed.projectId.trim()
      ? parsed.projectId.trim() : null;
  } catch { return null; }
}

function nearestProject(startDir) {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const local = readSmall(join(dir, '.agenfk', 'local.json'));
    const shared = readSmall(join(dir, '.agenfk', 'project.json'));
    if (local !== null || shared !== null) return { root: dir, projectId: idIn(local) ?? idIn(shared) };
    if (dirname(dir) === dir) return null;
  }
}

function within(p, dir) {
  return p === dir || p.startsWith(dir + sep);
}

function linkedWorktreeOf(dir) {
  for (let cur = resolve(dir); ; cur = dirname(cur)) {
    const dotGit = join(cur, '.git');
    let st = null;
    try { st = lstatSync(dotGit); } catch { /* none here */ }
    if (st && !st.isFile()) return null;
    if (st && st.isFile()) {
      const text = st.size <= 4096 ? readSmall(dotGit) : null;
      const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
      if (!m) return null;
      const gitDir = resolve(cur, m[1]);
      const common = dirname(dirname(gitDir));
      if (basename(dirname(gitDir)) !== 'worktrees' || basename(common) !== '.git') return null;
      const config = readSmall(join(common, 'config'));
      if (config && /^\s*bare\s*=\s*true\s*$/mi.test(config)) return null;
      return { top: cur, main: dirname(common) };
    }
    if (dirname(cur) === cur) return null;
  }
}

/**
 * Is this note about the project this session is actually in?
 *
 * The shared note is the only one the CLI gatekeeper writes, so without this
 * check the last card authorized by ANY session on the machine captures the
 * runs of every session. Refusing a note that names a different project is
 * the safe half: a run on the wrong card is worse than no run, which is the
 * rule this recorder already lives by. An unknown on either side keeps the
 * old behaviour — refusing there would kill recording where it used to work.
 */
export function noteMatchesProject(note, projectId) {
  if (!projectId) return true;
  const noteProject = note && typeof note.projectId === 'string' ? note.projectId : '';
  if (!noteProject) return true;
  return noteProject === projectId;
}

/**
 * The card this session is working on.
 *
 * Read from the note `agenfk gatekeeper` writes when it authorizes an edit —
 * never guessed. `GET /items?active=true` routinely returns dozens of items
 * across projects, and server.ts says why guessing is wrong in its own comment
 * on POST /agent-runs. Attributing an agent's work to the wrong card is worse
 * than recording none, so no note means no run.
 */
/**
 * Exported for tests (CGLAB-570's session-isolation spec): it is the exact
 * seam a tool call crosses before a run is opened. `readActiveWork` is
 * injected, so the test can stand in for the dist reader without a server.
 */
export async function activeItem(readActiveWork, sessionId, projectId) {
  const work = readActiveWork(sessionId);
  if (!work?.itemId) return null;
  if (!noteMatchesProject(work, projectId)) return null;
  const item = await api(`/items/${encodeURIComponent(work.itemId)}`);
  return item?.id ? item : null;
}

/**
 * 7251a4f7 - the model a run records. AGENFK_MODEL when set; else the last
 * model the session's transcript shows (Claude Code writes one per assistant
 * message; '<synthetic>' entries are its own, not a model); else 'claude'.
 * Read from the end: the transcript grows for the whole session.
 */
export function runModel(env, payload) {
  if (env && env.AGENFK_MODEL) return env.AGENFK_MODEL;
  const file = payload && typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (file) {
    try {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"model"')) continue;
        try {
          const model = JSON.parse(lines[i])?.message?.model;
          if (typeof model === 'string' && model && !model.startsWith('<')) return model;
        } catch { /* a line being written: skip it */ }
      }
    } catch { /* no transcript: fall back */ }
  }
  return 'claude';
}

async function ensureRun(sessionId, readActiveWork, projectId, payload) {
  // The note is consulted FIRST, every time. Keying the cache on the session
  // alone let it short-circuit ahead of the note, so switching cards mid
  // session kept posting to the first card's run — the wrong-card failure this
  // whole design exists to prevent. The key is session + item.
  const item = await activeItem(readActiveWork, sessionId, projectId);
  if (!item) return null;

  const cacheKey = `${sessionId || 'nosession'}::${item.id}`;
  const map = readRunMap();
  // The KEY comes back with the id. The caller needs it to drop the entry when
  // the server says the run is gone, and recomputing it there would be a
  // second place that has to agree about how the key is built.
  if (map[cacheKey]) return { runId: map[cacheKey], cacheKey };

  const run = await api('/agent-runs', {
    method: 'POST',
    body: JSON.stringify({
      itemId: item.id,
      projectId: item.projectId,
      step: item.status,
      actor: 'worker',
      harness: CLIENT,
      model: runModel(process.env, payload),
      sessionId: sessionId || undefined,
    }),
  });
  if (!run?.id) return null;
  rememberRun(cacheKey, run.id);
  return { runId: run.id, cacheKey };
}

async function main() {
  const raw = await readStdin();
  // A Write payload carries the whole file, which the mapper then throws away.
  // Parsing 30MB per tool call to learn a path is not worth the allocation.
  if (raw.length > 1_000_000) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // not our shape; say nothing
  }

  /*
   * The session ended: close the run.
   *
   * Nothing did this, so every run this hook opened stayed `running` with no
   * endedAt FOREVER. The sessions rail then shows work that finished weeks ago
   * as still in flight, and the states that depend on a run reaching an
   * outcome — waiting, failed — are unreachable by construction.
   *
   * `done` and not `failed`: this hook cannot see whether the work succeeded,
   * and claiming a verdict it did not observe would be worse than claiming
   * none. The server stamps endedAt itself when a terminal status arrives.
   *
   * The cache entry goes too. A closed run must not receive events if the
   * session somehow emits more — and see `closesRun` for why that sentence is
   * the reason getting the EVENT right matters so much.
   *
   * FIRST, before the dist imports below, and the ordering is the point.
   * SessionEnd hooks are given a far tighter budget than every other event —
   * 1.5 seconds against ten minutes — so this path has to spend it on the work
   * and nothing else. It needs neither the event mapper nor the active-work
   * reader, and resolving two dynamic imports ahead of it spent the budget on
   * modules it does not use. A close that misses its deadline is lost in
   * silence, which is the failure this whole change exists to remove.
   *
   * Concurrent, for the same reason: one PATCH per cached key, each with its
   * own deadline, meant a single slow request could eat the budget for all of
   * them. There is no ordering between runs.
   */
  if (closesRun(payload.hook_event_name)) {
    const map = readRunMap();
    const prefix = `${payload.session_id || 'nosession'}::`;
    const mine = Object.entries(map).filter(([key]) => key.startsWith(prefix));
    await Promise.all(mine.map(async ([key, runId]) => {
      await api(`/agent-runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
      forgetRun(key);
    }));
    return;
  }

  // The mapper decides what is worth recording and strips anything sensitive.
  // Resolved by path rather than package name: bin/ and packages/ are siblings
  // in both a source checkout and the extracted install, and a bare specifier
  // would depend on a node_modules layout the hook cannot count on.
  const distDir = ['../packages/server/dist/agent-runs', '../../packages/server/dist/agent-runs']
    .map(rel => resolve(HERE, rel))
    .find(dir => existsSync(join(dir, 'claude-events.js')));
  if (!distDir) return;

  const [{ toRunEvent }, { readActiveWorkForSession: readActiveWork }] = await Promise.all([
    import(pathToFileURL(join(distDir, 'claude-events.js')).href),
    import(pathToFileURL(join(distDir, 'activeWork.js')).href),
  ]).catch(() => [{}, {}]);
  if (!toRunEvent || !readActiveWork) return;

  const event = toRunEvent(payload);
  if (!event) return;

  // The session's OWN project, from its cwd — not from the note. Comparing
  // the two is what stops one session's card capturing another's runs.
  const run = await ensureRun(payload.session_id, readActiveWork, projectIdFromCwd(payload.cwd), payload);
  if (!run) return;

  const posted = await api(`/agent-runs/${run.runId}/events`, {
    method: 'POST',
    body: JSON.stringify(event),
  });

  // 404 means the run is gone from the server while this session still holds
  // its id — a reset database, a restored backup. Forget it so the NEXT event
  // opens a fresh run, rather than posting into a void for the rest of the
  // session with nothing surfacing.
  if (posted?.__status === 404) forgetRun(run.cacheKey);
}

// Nothing this hook does is worth failing a tool call over — including taking
// too long. Without this watchdog a stdin that never reaches EOF would leave
// main() pending and stall the session until the client's own hook timeout.
/*
 * Only when RUN as a hook, not when imported.
 *
 * Without the guard this file starts a watchdog and exits the process the
 * moment anything imports it — which is why its internals had no tests: a test
 * that imported it killed its own runner. The helpers below are exported for
 * that reason and for no other; nothing outside this file uses them.
 */
const runningAsHook = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runningAsHook) {
  // Nothing this hook does is worth failing a tool call over — including
  // taking too long. Without this watchdog a stdin that never reaches EOF
  // would leave main() pending and stall the session until the client's own
  // hook timeout.
  setTimeout(() => process.exit(0), 3000).unref();
  main().catch(() => {}).finally(() => process.exit(0));
}

/**
 * Does this hook event mean the SESSION is over?
 *
 * Only one does, and the difference is not a detail. `Stop` was treated as a
 * close and it is a PER-TURN hook: the Claude Code binary describes it as one
 * that can block "the turn from ending" and hands it `stop_hook_active` so a
 * hook can tell it is being re-entered within the same turn. It fires every
 * time the assistant finishes answering, with the session still very much
 * alive and its human about to type again.
 *
 * Closing on it did two things, and the second is the worse one. The run was
 * marked `done` while the work continued — so anything reading `status` to
 * mean "this session finished" was wrong once per turn. And because closing
 * drops the cache entry, the next tool call opened a BRAND NEW run: one
 * session became dozens, each holding a few minutes of a conversation that
 * was never actually split.
 *
 * A closed list, and everything unknown is NOT a close. Hook events get added,
 * and the two failures are not symmetric: a run left open too long is visible
 * and can be closed later, while one closed early silently discards the rest
 * of the session's history.
 *
 * The case this gives up is a session that never sends `SessionEnd` at all —
 * a crash, a `kill -9`. That run stays `running` forever, and it is handled
 * where it belongs: the sessions rail drops runs that predate the app's launch
 * and have gone quiet (see liveSessions.ts), rather than the hook declaring
 * every turn boundary a death to be safe.
 */
function closesRun(eventName) {
  return eventName === 'SessionEnd';
}

export { forgetRun, rememberRun, readRunMap, RUN_MAP, closesRun };
