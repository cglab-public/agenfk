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
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
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
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
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
 * The card this session is working on.
 *
 * Read from the note `agenfk gatekeeper` writes when it authorizes an edit —
 * never guessed. `GET /items?active=true` routinely returns dozens of items
 * across projects, and server.ts says why guessing is wrong in its own comment
 * on POST /agent-runs. Attributing an agent's work to the wrong card is worse
 * than recording none, so no note means no run.
 */
async function activeItem(readActiveWork, sessionId) {
  const work = readActiveWork(sessionId);
  if (!work?.itemId) return null;
  const item = await api(`/items/${encodeURIComponent(work.itemId)}`);
  return item?.id ? item : null;
}

async function ensureRun(sessionId, readActiveWork) {
  // The note is consulted FIRST, every time. Keying the cache on the session
  // alone let it short-circuit ahead of the note, so switching cards mid
  // session kept posting to the first card's run — the wrong-card failure this
  // whole design exists to prevent. The key is session + item.
  const item = await activeItem(readActiveWork, sessionId);
  if (!item) return null;

  const cacheKey = `${sessionId || 'nosession'}::${item.id}`;
  const map = readRunMap();
  if (map[cacheKey]) return map[cacheKey];

  const run = await api('/agent-runs', {
    method: 'POST',
    body: JSON.stringify({
      itemId: item.id,
      projectId: item.projectId,
      step: item.status,
      actor: 'worker',
      harness: CLIENT,
      model: process.env.AGENFK_MODEL || 'claude',
      sessionId: sessionId || undefined,
    }),
  });
  if (!run?.id) return null;
  rememberRun(cacheKey, run.id);
  return run.id;
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

  const runId = await ensureRun(payload.session_id, readActiveWork);
  if (!runId) return;

  await api(`/agent-runs/${runId}/events`, {
    method: 'POST',
    body: JSON.stringify(event),
  });
}

// Nothing this hook does is worth failing a tool call over — including taking
// too long. Without this watchdog a stdin that never reaches EOF would leave
// main() pending and stall the session until the client's own hook timeout.
setTimeout(() => process.exit(0), 3000).unref();
main().catch(() => {}).finally(() => process.exit(0));
