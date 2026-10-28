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
import net from 'net';
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

/**
 * True when the state file holds a policy an answer did not see: a higher
 * revision, or another source (hub and local revisions are counted apart).
 */
function stateIsNewer(state, known) {
  if (!state || typeof state.revision !== 'number') return false;
  if ((state.source ?? 'local') !== (known.source ?? 'local')) return true;
  return state.revision > (typeof known.revision === 'number' ? known.revision : -1);
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
      const fresh = typeof lastKnown.at === 'number' && now - lastKnown.at < LAST_KNOWN_TTL_MS;
      if (fresh && !stateIsNewer(state, lastKnown)) return { block: false, basis: 'last-known' };
    }
  }
  if (!state) return { block: false, basis: 'none' };
  return state.mode === 'enforce' && stateCoversSession(state, session) ? blocked('state-file') : { block: false, basis: 'state-file' };
}

// ── Launch gate (layer 2) ──────────────────────────────────────────────────

/** Set inside the Airlock sandbox (agenfk airlock pi|opencode) to the client's name. */
export const AIRLOCK_SANDBOX_MARKER = 'AGENFK_AIRLOCK_SANDBOX';
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const DENIED = new Set(['EPERM', 'EACCES', 'EROFS']);

/**
 * A literal address the sandbox never lets a process dial directly: the cloud
 * metadata endpoint (built-in deny). Outside the sandbox a direct connect is
 * refused by nothing local: it connects, times out or is unreachable.
 */
export const CONFINEMENT_PROBE = Object.freeze({ host: '169.254.169.254', port: 80 });
/** What the macOS sandbox (seatbelt) answers a direct connect with. */
const MACOS_CONFINED_CODES = ['EPERM', 'EACCES'];

/**
 * Linux evidence, from the kernel and fixed for the life of the process: it
 * is in a network namespace whose only device is the loopback one, which is
 * what bubblewrap's --unshare-net gives the sandbox. A host lists its real
 * devices even offline (down, but listed), so a missing route or an
 * ENETUNREACH is never evidence. And it is not the launcher's own namespace
 * when the launcher said which that is. NOT MEASURED: written from bwrap's
 * documented behaviour on a Mac; anything unreadable refuses admission.
 */
function linuxConfinement({ readFile, readlink, env }) {
  const refused = (why) => ({
    confined: false,
    reason: `${why}; without kernel evidence of the sandbox, Linux enforce-mode admission is refused`,
  });
  let netdev;
  try { netdev = String(readFile('/proc/self/net/dev')); } catch { return refused('/proc/self/net/dev could not be read'); }
  const devices = netdev.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  if (devices.length !== 1 || devices[0] !== 'lo') {
    return { confined: false, reason: `this process's network namespace has devices other than loopback (${devices.join(', ') || 'none'})` };
  }
  const host = typeof env?.AGENFK_AIRLOCK_HOST_NETNS === 'string' ? env.AGENFK_AIRLOCK_HOST_NETNS.trim() : '';
  if (host) {
    let own;
    try { own = String(readlink('/proc/self/ns/net')); } catch { return refused('/proc/self/ns/net could not be read'); }
    if (own === host) return { confined: false, reason: 'this process is in the launcher\'s own network namespace' };
  }
  return { confined: true };
}

/**
 * Prove this process is confined. macOS: a direct TCP connect to a literal
 * external address, bypassing any proxy, must be refused by the sandbox
 * (EPERM/EACCES); a connection, a timeout (offline?) or any other error is not
 * proof. Linux: kernel evidence (linuxConfinement), never a connect error.
 * Elsewhere: never.
 */
export function proveConfinement({
  connect = net.connect, timeoutMs = 1000, platform = process.platform,
  readFile = (p) => fs.readFileSync(p, 'utf8'), readlink = fs.readlinkSync, env = process.env,
} = {}) {
  if (platform === 'linux') return Promise.resolve(linuxConfinement({ readFile, readlink, env }));
  if (platform !== 'darwin') return Promise.resolve({ confined: false, reason: `the Airlock sandbox does not support ${platform}` });
  const codes = MACOS_CONFINED_CODES;
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy?.(); } catch { /* gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ confined: false, reason: `no answer from a direct connection to ${CONFINEMENT_PROBE.host} within ${timeoutMs}ms (offline?), so the sandbox could not be proven` }), timeoutMs);
    try {
      socket = connect({ host: CONFINEMENT_PROBE.host, port: CONFINEMENT_PROBE.port });
      socket.on('connect', () => finish({ confined: false, reason: 'a direct connection outside the proxy succeeded' }));
      socket.on('error', (e) => finish(codes.includes(e?.code)
        ? { confined: true }
        : { confined: false, reason: `a direct connection was not refused by a sandbox (${e?.code ?? e?.message ?? 'error'})` }));
    } catch (e) {
      finish({ confined: false, reason: `the direct connection could not be tried (${e?.message ?? e})` });
    }
  });
}

/** proveConfinement, run once for the life of the process (confinement cannot change). */
export function confinementOnce(opts = {}) {
  let result;
  return () => (result ??= proveConfinement(opts));
}
const processConfinement = confinementOnce();

/**
 * Is this process inside the Airlock sandbox? The marker and the proxy env the
 * launcher sets, ~/.agenfk unwritable, AND a direct connection refused by the
 * sandbox. Env vars and a chmod alone are not enough.
 * Resolves to { sandboxed: true } or { sandboxed: false, reason }.
 */
export async function airlockSandboxCheck({ env = process.env, homeDir = os.homedir(), access = fs.accessSync, prove = processConfinement } = {}) {
  const set = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!set(env[AIRLOCK_SANDBOX_MARKER])) return { sandboxed: false };
  if (!PROXY_VARS.some((k) => set(env[k]))) return { sandboxed: false };
  try {
    access(path.join(homeDir, '.agenfk'), fs.constants.W_OK);
    return { sandboxed: false, reason: '~/.agenfk is writable, which it never is inside the sandbox' };
  } catch (e) {
    if (!DENIED.has(e?.code)) return { sandboxed: false, reason: `~/.agenfk could not be checked (${e?.code ?? 'error'})` };
  }
  const proof = await prove();
  return proof?.confined ? { sandboxed: true } : { sandboxed: false, reason: proof?.reason ?? 'confinement was not proven' };
}

export const launchGateMessage = (client, reason) =>
  `[agenfk airlock] this ${client} session is covered by the Airlock policy in enforce mode but is not running ` +
  `inside the Airlock sandbox, so every tool call is refused.${reason ? ` The sandbox could not be confirmed: ${reason}.` : ''} ` +
  `Exit and relaunch it with: agenfk airlock ${client}`;

/**
 * Does the launch gate apply to this tool call: enforce mode, covering the
 * session? From this process's last answer for the session's model (unless
 * the state file holds a newer policy), else from the state file.
 */
export function gateEnforces({ lastKnown = null, stateFile = defaultStateFile(), session = {} } = {}) {
  const state = readState(stateFile);
  if (lastKnown && typeof lastKnown.mode === 'string' && !stateIsNewer(state, lastKnown)) {
    return lastKnown.mode === 'enforce' && lastKnown.applies === true;
  }
  return !!state && state.mode === 'enforce' && stateCoversSession(state, session);
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
  // pi's launch gate asks once per process: is this process confined?
  if (payload && payload.probe === 'confinement') {
    process.stdout.write(JSON.stringify(await proveConfinement()));
    return;
  }
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
