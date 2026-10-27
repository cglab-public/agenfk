#!/usr/bin/env node
/**
 * AgEnFK Airlock adapter (GH-294): the one script every Airlock client goes
 * through to have a tool call judged.
 *
 * The verdict comes from the local server (POST /airlock/evaluate), the single
 * owner of the policy and of the decision log; this script only carries the
 * call there and back. It is a standalone hook installed under ~/.agenfk/bin,
 * so it imports node builtins only (plus its sibling's port discovery).
 *
 *   - pi spawns it (stdin: the request JSON, stdout: the result JSON);
 *   - the OpenCode plugin imports it and awaits requestVerdict in-process.
 *
 * When the server cannot answer, decideWhenUnreachable is the single rule:
 * block only when the last-known mode is enforce and the session is covered by
 * the policy; allow otherwise.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveApiUrl } from './agenfk-gatekeeper.mjs';

/** The server refuses toolName, sessionId and model parts longer than this. */
export const MAX_FIELD = 256;
/** Any other argument larger than this travels as a placeholder. */
export const MAX_ARG_CHARS = 16 * 1024;
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * What the server judges (core's capabilitiesOf keys): never shortened, since a
 * shortened command or path list could hide the part that matters. A call too
 * big for the server is refused there and handled as unreachable.
 */
const JUDGED_KEYS = new Set([
  'command', 'cmd', 'commands',
  'path', 'file_path', 'filePath', 'notebook_path', 'paths',
  'url', 'uri', 'href',
]);
/**
 * File bodies. The KEY matters to the server (it marks the call as a write),
 * the body never does, so it travels as a placeholder.
 */
const CONTENT_KEYS = new Set([
  'content', 'newString', 'oldString', 'new_string', 'old_string', 'edits',
  'new_source', 'patch', 'patchText', 'text',
]);

const omitted = (chars) => `[omitted by agenfk airlock: ${chars} chars]`;

function sizeOf(value) {
  if (typeof value === 'string') return value.length;
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Infinity; }
}

/**
 * The tool call's arguments as they are sent to the server: commands, paths
 * and URLs whole (they are what is judged); file bodies, and anything else
 * over 16KB, replaced by a short placeholder that keeps the key. Never changes
 * the caller's object.
 */
export function boundArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (JUDGED_KEYS.has(key)) { out[key] = value; continue; }
    if (CONTENT_KEYS.has(key)) { out[key] = omitted(sizeOf(value)); continue; }
    const size = sizeOf(value);
    out[key] = size > MAX_ARG_CHARS ? omitted(size) : value;
  }
  return out;
}

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_FIELD) : v);
/** How long a server answer may stand in for the server when it is unreachable. */
export const LAST_KNOWN_TTL_MS = 30_000;

/** `provider/model` (pi's joined form) or { provider, id }, as { provider, id } | null. */
export function sessionModel(model) {
  if (model === undefined || model === null) return null;
  if (typeof model === 'string') {
    const m = model.trim();
    if (!m) return null;
    const slash = m.indexOf('/');
    return slash > 0 ? { provider: m.slice(0, slash), id: m.slice(slash + 1) || null } : { provider: null, id: m };
  }
  if (typeof model !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    provider: str(model.provider) ?? str(model.providerID),
    id: str(model.id) ?? str(model.modelID) ?? str(model.model),
  };
}

/**
 * Ask the local server to judge one tool call.
 * Resolves to { status: 'ok', verdict, mode, applies, revision, source } or
 * { status: 'unreachable', reason }. Never throws, never waits past timeoutMs.
 */
export async function requestVerdict(payload, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    env = process.env,
    homeDir = os.homedir(),
  } = opts;
  if (typeof fetchImpl !== 'function') return { status: 'unreachable', reason: 'no fetch in this runtime' };
  const p = payload && typeof payload === 'object' ? payload : {};
  const model = sessionModel(p.model);
  // A model part is never clipped: a clipped id is another model, and the
  // verdict would be about some other session. The caller's fallback judges
  // the original model instead.
  if (model && ((model.provider?.length ?? 0) > MAX_FIELD || (model.id?.length ?? 0) > MAX_FIELD)) {
    return { status: 'unreachable', reason: `a model part is longer than the server's ${MAX_FIELD}-character limit` };
  }
  const body = {
    client: p.client,
    model,
    toolName: clip(typeof p.toolName === 'string' ? p.toolName : ''),
    args: boundArgs(p.args),
  };
  // A clipped id names some other session, so an over-long one is left out.
  if (typeof p.sessionId === 'string' && p.sessionId && p.sessionId.length <= MAX_FIELD) body.sessionId = p.sessionId;
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'unreachable', reason: `no answer within ${timeoutMs}ms` });
    }, timeoutMs);
  });
  const ask = (async () => {
    try {
      const res = await fetchImpl(`${resolveApiUrl(env, homeDir)}/airlock/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res || !res.ok) return { status: 'unreachable', reason: `the server answered ${res?.status ?? 'nothing'}` };
      const json = await res.json();
      const verdict = json?.verdict;
      if (!verdict || typeof verdict.decision !== 'string') return { status: 'unreachable', reason: 'the answer carried no verdict' };
      return {
        status: 'ok',
        verdict,
        mode: json.mode,
        applies: json.applies === true,
        revision: json.revision,
        source: json.source,
      };
    } catch (e) {
      return { status: 'unreachable', reason: e?.message || String(e) };
    }
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when a tool call carries something Airlock judges: a command, a local
 * path or a URL, under the argument keys core's capabilitiesOf reads. The
 * tool's name plays no part.
 */
export function hasCapabilities(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const local = (v) => text(v) && !v.startsWith('xd://') && v !== 'local://';
  for (const k of ['command', 'cmd', 'commands']) {
    const v = args[k];
    if ((Array.isArray(v) ? v : [v]).some(text)) return true;
  }
  const paths = [args.path, args.file_path, args.filePath, args.notebook_path, ...(Array.isArray(args.paths) ? args.paths : [])];
  if (paths.some(local)) return true;
  return [args.url, args.uri, args.href].some(text);
}

/** What the agent is told when a verdict stops its call, or null to let it through. */
export function blockMessage(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  if (verdict.decision === 'deny') return `[agenfk airlock] ${verdict.rule}: ${verdict.reason}`;
  if (verdict.decision === 'needs-human-approval') {
    return `[agenfk airlock] ${verdict.rule}: ${verdict.reason}. A person must approve request ${verdict.approvalKey} ` +
      'on the AgEnFK board (agenfk ui); once it is approved, retry the same call.';
  }
  return null;
}

/** The fallback copy of the policy the server writes (0600). */
export const defaultStateFile = (homeDir = os.homedir()) => path.join(homeDir, '.agenfk', 'airlock-state.json');

function readState(stateFile) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

/** Case-insensitive `*` / `?` glob; an omitted pattern matches anything (core's selector rule). */
function glob(pattern, value) {
  if (pattern === undefined || pattern === null || pattern === '*') return true;
  const re = new RegExp(
    `^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i',
  );
  return re.test(value ?? '');
}

/** Does the policy in the state file cover this session? Mirrors core's modelSelected. */
export function stateCoversSession(state, session = {}) {
  const model = sessionModel(session.model) ?? { provider: null, id: null };
  if (!model.id) return state.appliesWhenModelUnknown !== false;
  const models = Array.isArray(state.models) ? state.models : [];
  return models.length === 0 || models.some((s) =>
    s && typeof s === 'object' &&
    (s.client === undefined || s.client === '*' || s.client === session.client) &&
    glob(s.provider, model.provider) &&
    glob(s.model, model.id));
}

/**
 * The single rule for a tool call the server could not judge. The last answer
 * this process got ({ mode, applies, revision, source, at }) wins if it blocks
 * (enforce, covering the session) until a strictly newer same-source state file
 * replaces it, and if it allows only while under 30 s old with nothing newer
 * written; otherwise the state file the server last wrote decides. Block
 * only when that says enforce AND the session is covered; allow otherwise
 * (including when there is no readable state at all).
 */
export function decideWhenUnreachable(lastKnown, stateFile = defaultStateFile(), session = {}, now = Date.now()) {
  const blocked = (basis) => ({
    block: true,
    basis,
    reason: '[agenfk airlock] the AgEnFK server could not be reached to check this tool call, and the Airlock policy ' +
      'enforces for this session, so it is refused. Start the server (agenfk up) and retry.',
  });
  const state = readState(stateFile);
  if (lastKnown && typeof lastKnown === 'object' && typeof lastKnown.mode === 'string') {
    const sameSource = !!state && (state.source ?? 'local') === (lastKnown.source ?? 'local');
    const knownRevision = typeof lastKnown.revision === 'number' ? lastKnown.revision : -1;
    const strictlyNewer = sameSource && typeof state.revision === 'number' && state.revision > knownRevision;
    if (lastKnown.mode === 'enforce' && lastKnown.applies === true) {
      // Expiry removes only permissiveness: a blocking answer holds, however
      // old, until a strictly newer revision from the same source replaces it.
      // A missing, unreadable, older or other-source state file never does.
      if (!strictlyNewer) return blocked('last-known');
    } else {
      // A permissive answer stands only while fresh (it carries `at`) and the
      // state file holds nothing newer: a higher revision, or another source
      // (hub and local revisions are counted apart).
      const otherSource = !!state && typeof state.revision === 'number' && !sameSource;
      const fresh = typeof lastKnown.at === 'number' && now - lastKnown.at < LAST_KNOWN_TTL_MS;
      if (fresh && !strictlyNewer && !otherSource) return { block: false, basis: 'last-known' };
    }
  }
  if (!state) return { block: false, basis: 'none' };
  return state.mode === 'enforce' && stateCoversSession(state, session) ? blocked('state-file') : { block: false, basis: 'state-file' };
}

// ── main: stdin JSON -> result JSON (pi spawns this) ────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let payload;
  try { payload = JSON.parse(await readStdin()); } catch { payload = null; }
  const result = payload && typeof payload === 'object'
    ? await requestVerdict(payload)
    : { status: 'unreachable', reason: 'the request was not JSON' };
  process.stdout.write(JSON.stringify(result));
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch { return false; }
})();
if (isMain) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ status: 'unreachable', reason: 'the airlock script failed' }));
  });
}
