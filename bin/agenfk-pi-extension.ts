/**
 * AgEnFK native extension for pi (https://pi.dev / @earendil-works/pi-coding-agent).
 *
 * Installed to ~/.pi/agent/extensions/agenfk.ts and auto-loaded by pi (jiti — no
 * build step, no node_modules). It wires AgEnFK enforcement + nudges into pi's
 * in-process event system:
 *
 *   • #1 PR-open reminder  — on tool_result(bash), classify `gh pr create` /
 *        `git push` via the shared agenfk-pr-hook.mjs and inject a steer message
 *        telling the agent to call register_pr/update_pr_sizing.
 *   • #2 Deterministic model — resolve the model pi is ACTUALLY running from the
 *        sources pi itself publishes (PI_PROVIDER/PI_MODEL on the bash tool env,
 *        ctx.getModel(), model_select, the session transcript), so the reminder
 *        carries the REAL model id + harness=pi instead of the agent guessing it.
 *        ~/.pi/agent/settings.json is a LAST resort only: its defaultModel is the
 *        STARTUP model read without its defaultProvider, so it goes stale on a
 *        model switch and is not the live model (the recurring "reported the wrong
 *        model id" bug — a pi/GLM session reported @cf/zai-org/glm-5.2 while its
 *        own transcript recorded qwen38-flashnext).
 *   • #3 Enforcement parity — on tool_call(edit|write) delegate to agenfk-gatekeeper.mjs
 *        (block when no task is active) and on tool_call(bash) delegate to
 *        agenfk-mcp-enforcer.mjs (block direct-DB / curl-localhost bypass routes).
 *   • #4 Load confirmation — on session_start, emit a one-line ctx.ui.notify toast
 *        proving the extension actually loaded AND that pi's event bus dispatches to
 *        it; it carries the detected model so it doubles as a getModel() smoke test.
 *
 * Decision logic is delegated to the same ~/.agenfk/bin/*.mjs scripts every other
 * client uses, so there is a single source of truth. The only natively-pi parts
 * are model capture (a spawned script cannot see pi's ctx) and message injection.
 *
 * Verified against the pi extension API (stable across the 0.79.x–0.80.x line):
 *   - handlers are (event, ctx) => …            (ExtensionHandler<E,R>)
 *   - tool_call blocks via return { block, reason }   (ToolCallEventResult)
 *   - ctx.getModel(): Model | undefined          (ExtensionContextActions)
 *   - ctx.ui.notify(message, "info" | "warning" | "error")  (ExtensionUIContext)
 *   - pi.sendMessage(msg, { deliverAs, triggerTurn })
 *
 * Every handler is wrapped so a failure can never break the host agent.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * IMPORTANT: this file is copied to ~/.pi/agent/extensions/agenfk.ts and loaded by
 * pi's jiti WITHOUT node_modules, so it must stay dependency-free — no imports from
 * @agenfk/* and no imports from pi's own packages. That is why the transcript is
 * located through the PI_SESSION_FILE pi exports rather than by importing pi's
 * session-manager: if that variable is absent (ephemeral sessions, non-pi shells)
 * readPiSessionModel degrades to null — a missed source, never a wrong model.
 */

// Minimal local typings — pi ships richer types via @earendil-works/pi-coding-agent,
// but we avoid importing it so the file loads with zero dependencies.
interface PiModel { provider?: string; id?: string }
interface PiEvent {
  toolName?: string;
  input?: {
    command?: string; cmd?: string; path?: string; file_path?: string;
    // omp's ast_edit carries its targets in `paths` (a write to the xd://ast_edit
    // device); NotebookEdit uses `notebook_path`.
    paths?: unknown[]; notebook_path?: string;
    [k: string]: unknown;
  };
  model?: PiModel;
  [k: string]: unknown;
}
interface PiUi { notify?: (message: string, type?: 'info' | 'warning' | 'error') => void }
// pi 1.4's ExtensionContext carries the live model as `model` (with `cwd`);
// getModel() exists only on an internal runner type and is kept as a fallback.
interface PiContext { model?: PiModel; getModel?: () => PiModel | undefined; ui?: PiUi; cwd?: string; sessionManager?: { getSessionId?: () => string } }
interface PiMessage { customType: string; content: string; display?: boolean }
interface PiSendOptions { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
interface PiApi {
  on(event: string, handler: (event: PiEvent, ctx: PiContext) => unknown): void;
  sendMessage(message: PiMessage, options?: PiSendOptions): void;
}

interface BlockVerdict { decision?: string; reason?: string }
interface ReminderResult { message?: string }

export interface PiExtensionDeps {
  gatekeeperVerdict: (filePath: string | undefined) => BlockVerdict | null;
  enforcerVerdict: (command: string | undefined) => BlockVerdict | null;
  /** The enforcer's word on pi's `read` tool: the database files stay closed (BUG ec325925). */
  readVerdict: (filePath: string | undefined) => BlockVerdict | null;
  prReminder: (command: string | undefined) => ReminderResult | null;
  // pi's STARTUP model from ~/.pi/agent/settings.json. LAST resort: it carries no
  // provider and goes stale on a model switch, so the sources below outrank it.
  readDefaultModel: () => string | null;
  // The model that actually answered, from pi's session transcript (PI_SESSION_FILE).
  readTranscriptModel: () => string | null;
  // The model pi attributes to the command being run (PI_PROVIDER/PI_MODEL).
  readEnvModel: () => string | null;
  /**
   * Airlock's verdict on a tool call, from the shared ~/.agenfk/bin/agenfk-airlock.mjs
   * (GH-294). null when it could not run (no runtime, no script, no answer).
   * Optional so a caller that never wires Airlock is unaffected.
   */
  airlockVerdict?: (request: AirlockRequest) => AirlockResult | null;
  /** The policy copy the server writes to ~/.agenfk/airlock-state.json, or null. */
  readAirlockState?: () => AirlockState | null;
  /**
   * Is this pi inside the Airlock sandbox (agenfk airlock pi)? Wired, it turns
   * on the launch gate; optional so a caller that never wires it is unaffected.
   */
  isSandboxed?: () => boolean | AirlockSandboxStatus;
}

// ── Airlock (GH-294) ─────────────────────────────────────────────────────────

export interface AirlockSessionModel { provider: string | null; id: string | null }
export interface AirlockRequest {
  client: 'pi';
  model: AirlockSessionModel | null;
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  cwd?: string;
}
interface AirlockVerdict { decision: string; rule?: string; reason?: string; approvalKey?: string }
export type AirlockResult =
  | { status: 'ok'; verdict: AirlockVerdict; mode: string; applies: boolean; revision?: number; source?: string }
  | { status: 'unreachable'; reason?: string };
export interface AirlockState {
  mode?: string;
  revision?: number;
  source?: string;
  models?: Array<{ client?: string; provider?: string; model?: string }>;
  appliesWhenModelUnknown?: boolean;
}
/** What this process last heard from the server. The agent's shell cannot write it. */
interface AirlockLastKnown { mode: string; applies: boolean; revision?: number; source?: string; at: number; modelKey: string }

/** An `off` answer is trusted for this long before the server is asked again. */
export const AIRLOCK_OFF_TTL_MS = 30_000;
/** How long a server answer may stand in for the server when it is unreachable. */
export const AIRLOCK_LAST_KNOWN_TTL_MS = 30_000;

/**
 * True when the state file holds a policy the answer did not see: a higher
 * revision, or another source (hub and local revisions are counted apart).
 */
function airlockStateIsNewer(state: AirlockState | null, known: { revision?: number; source?: string }): boolean {
  if (!state || typeof state.revision !== 'number') return false;
  if ((state.source ?? 'local') !== (known.source ?? 'local')) return true;
  return state.revision > (typeof known.revision === 'number' ? known.revision : -1);
}

/**
 * True when a tool call carries something Airlock judges: a command, a local
 * path or a URL, under the argument keys core's capabilitiesOf reads. The tool's
 * name plays no part.
 */
export function hasAirlockCapabilities(input: Record<string, unknown> | undefined | null): boolean {
  if (!input || typeof input !== 'object') return false;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const local = (v: unknown) => text(v) && !(v as string).startsWith('xd://') && (v as string) !== 'local://';
  for (const k of ['command', 'cmd', 'commands']) {
    const v = input[k];
    if ((Array.isArray(v) ? v : [v]).some(text)) return true;
  }
  const paths = [input.path, input.file_path, input.filePath, input.notebook_path, ...(Array.isArray(input.paths) ? input.paths : [])];
  if (paths.some(local)) return true;
  return [input.url, input.uri, input.href].some(text);
}

/** `provider/model` as pi joins it, split at the first slash (core's modelFromPi). */
function splitJoinedModel(joined: string): AirlockSessionModel {
  const j = joined.trim();
  const slash = j.indexOf('/');
  return slash > 0 ? { provider: j.slice(0, slash), id: j.slice(slash + 1) || null } : { provider: null, id: j || null };
}

function airlockGlob(pattern: string | undefined, value: string | null): boolean {
  if (pattern === undefined || pattern === null || pattern === '*') return true;
  const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(value ?? '');
}

/**
 * The rule for a tool call the server could not judge. It mirrors
 * decideWhenUnreachable in bin/agenfk-airlock.mjs, because pi reaches that
 * script by spawning it, and the cases here are exactly the ones where the
 * spawn gave nothing back. Block only when the last-known mode (this process's
 * last answer for this model, else the state file) is enforce AND the session
 * is covered; allow otherwise.
 */
export function airlockWhenUnreachable(
  lastKnown: { mode: string; applies: boolean; revision?: number; source?: string; at?: number } | null,
  state: AirlockState | null,
  model: AirlockSessionModel | null,
  now: number = Date.now(),
): { block: boolean; reason?: string } {
  const blocked = {
    block: true,
    reason: '[agenfk airlock] the AgEnFK server could not be reached to check this tool call, and the Airlock policy ' +
      'enforces for this session, so it is refused. Start the server (agenfk up) and retry.',
  };
  if (lastKnown) {
    if (lastKnown.mode === 'enforce' && lastKnown.applies) {
      // Expiry removes only permissiveness: a blocking answer holds, however
      // old, until a strictly newer revision from the same source replaces it.
      // A missing, unreadable, older or other-source state file never does.
      const sameSource = !!state && (state.source ?? 'local') === (lastKnown.source ?? 'local');
      const replaced = sameSource && typeof state?.revision === 'number' &&
        state.revision > (typeof lastKnown.revision === 'number' ? lastKnown.revision : -1);
      if (!replaced) return blocked;
    } else if (typeof lastKnown.at === 'number' && now - lastKnown.at < AIRLOCK_LAST_KNOWN_TTL_MS &&
      !airlockStateIsNewer(state, lastKnown)) {
      // A permissive answer stands only while fresh and nothing newer was written.
      return { block: false };
    }
  }
  if (!state || state.mode !== 'enforce') return { block: false };
  return airlockStateCovers(state, model) ? blocked : { block: false };
}

/** Does the policy in the state file cover a pi session on this model? Mirrors core's modelSelected. */
function airlockStateCovers(state: AirlockState, model: AirlockSessionModel | null): boolean {
  if (!model?.id) return state.appliesWhenModelUnknown !== false;
  const models = Array.isArray(state.models) ? state.models : [];
  return models.length === 0 || models.some((s) =>
    !!s && typeof s === 'object' &&
    (s.client === undefined || s.client === '*' || s.client === 'pi') &&
    airlockGlob(s.provider, model.provider) && airlockGlob(s.model, model.id));
}

// ── Airlock launch gate (layer 2) ────────────────────────────────────────────

const AIRLOCK_PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

export interface AirlockConfinement { confined: boolean; reason?: string }
export interface AirlockSandboxStatus { sandboxed: boolean; reason?: string }

/**
 * Is this process inside the Airlock sandbox? The marker and the proxy env
 * `agenfk airlock pi` sets, ~/.agenfk unwritable, AND a direct connection
 * refused by the sandbox (`prove`, see proveConfinement in
 * bin/agenfk-airlock.mjs). Env vars and a chmod alone are not enough. Mirrors
 * airlockSandboxCheck there.
 */
export function airlockSandboxed(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = os.homedir(),
  access: (p: string, mode: number) => void = fs.accessSync,
  prove: () => AirlockConfinement | null = processConfinement,
): AirlockSandboxStatus {
  const set = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (!set(env.AGENFK_AIRLOCK_SANDBOX)) return { sandboxed: false };
  if (!AIRLOCK_PROXY_VARS.some((k) => set(env[k]))) return { sandboxed: false };
  try {
    access(path.join(homeDir, '.agenfk'), fs.constants.W_OK);
    return { sandboxed: false, reason: '~/.agenfk is writable, which it never is inside the sandbox' };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? '';
    if (!['EPERM', 'EACCES', 'EROFS'].includes(code)) return { sandboxed: false, reason: `~/.agenfk could not be checked (${code || 'error'})` };
  }
  const proof = prove();
  return proof?.confined ? { sandboxed: true } : { sandboxed: false, reason: proof?.reason ?? 'the confinement probe gave no answer' };
}

/**
 * The confinement proof, run once per process through the shared script
 * (pi's hooks are synchronous, the probe is a socket). A probe that could not
 * run at all is not remembered, so a later call tries again.
 */
let confinementResult: AirlockConfinement | null = null;
function processConfinement(): AirlockConfinement | null {
  if (confinementResult) return confinementResult;
  const r = runHookScript('agenfk-airlock.mjs', [], { probe: 'confinement' });
  if (r && typeof r.confined === 'boolean') confinementResult = { confined: r.confined, reason: typeof r.reason === 'string' ? r.reason : undefined };
  return confinementResult;
}

export const airlockLaunchGateReason = (reason?: string): string =>
  '[agenfk airlock] this pi session is covered by the Airlock policy in enforce mode but is not running ' +
  `inside the Airlock sandbox, so every tool call is refused.${reason ? ` The sandbox could not be confirmed: ${reason}.` : ''} ` +
  'Exit and relaunch it with: agenfk airlock pi';


/** The block a verdict asks for, or null to let the call through. */
export function airlockBlock(verdict: AirlockVerdict): { block: true; reason: string } | null {
  if (verdict.decision === 'deny') {
    return { block: true, reason: `[agenfk airlock] ${verdict.rule}: ${verdict.reason}` };
  }
  if (verdict.decision === 'needs-human-approval') {
    return {
      block: true,
      reason: `[agenfk airlock] ${verdict.rule}: ${verdict.reason}. A person must approve request ${verdict.approvalKey} ` +
        'on the AgEnFK board (agenfk ui); once it is approved, retry the same call.',
    };
  }
  return null;
}

const HOOK_DIR = path.join(os.homedir(), '.agenfk', 'bin');

// ── Hook runtime resolution ──────────────────────────────────────────────────

/**
 * The runtime used to execute the ~/.agenfk/bin/*.mjs hooks.
 *
 * Under pi this is `process.execPath`, the Node binary pi runs under. That
 * assumption breaks on a Bun standalone host (the omp fork): there
 * `process.execPath` is the HOST binary, so spawning it re-enters the host with
 * the script as an argument, hangs until the timeout, and the extension then
 * fails open on every mutating tool. Resolve a real runtime instead:
 *
 *   1. `AGENFK_NODE` — an explicit override, for unusual installs.
 *   2. `node` on PATH — the normal case, and what pi itself brought.
 *   3. `process.execPath` — only on a Node host, where it is trustworthy.
 *
 * On a Bun host with neither override nor `node`, the result is null and the
 * enforcing caller fails CLOSED (a block verdict) instead of silently
 * disabling AgEnFK. Memoised by `hookRuntimeFor`.
 */
export function resolveHookRuntime(
  env: Record<string, string | undefined> = process.env,
  versions: Record<string, string | undefined> = process.versions as unknown as Record<string, string | undefined>,
  probe: (cmd: string) => boolean = probeRuntime,
): string | null {
  const override = (env.AGENFK_NODE ?? '').trim();
  if (override && probe(override)) return override;
  if (probe('node')) return 'node';
  // A Bun host can run the ESM hooks, but only when the binary is plain Bun;
  // the standalone app binary is not, so it is never a candidate.
  if (versions.bun && probe('bun')) return 'bun';
  if (!versions.bun) return process.execPath;
  return null;
}

/** True when `cmd` runs and reports a version. Cheap, side-effect free. */
function probeRuntime(cmd: string): boolean {
  try {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 1000, windowsHide: true });
    return res.status === 0 || Boolean((res.stdout || '').trim());
  } catch {
    return false;
  }
}

let hookRuntime: string | null | undefined;
/** The memoised hook runtime, or null when the hooks cannot run on this host. */
function hookRuntimeFor(): string | null {
  if (hookRuntime === undefined) {
    try { hookRuntime = resolveHookRuntime(); } catch { hookRuntime = null; }
  }
  return hookRuntime;
}

const HOOK_RUNTIME_MISSING =
  'AgEnFK cannot enforce the workflow: no Node runtime was found for the hooks. ' +
  'Set AGENFK_NODE or put `node` on PATH. Refusing this destructive tool rather than failing open.';

// ── Tool target resolution ───────────────────────────────────────────────────

/**
 * The mutating tools the hosts expose. pi sends edit/write; the omp fork adds
 * ast_edit, apply_patch, multiedit, str_replace, move, delete, notebook. All of
 * them are gated, because the gatekeeper is a workflow gate, not a syntax gate.
 */
const GATED_WRITE_TOOLS = new Set([
  'edit', 'write', 'ast_edit', 'apply_patch', 'multiedit', 'str_replace',
  'move', 'delete', 'notebook', 'create',
]);

/**
 * The real workspace path a mutating tool is about to touch, or undefined when
 * the call carries none. `xd://…` names a tool device, not a file (omp's
 * ast_edit arrives as a write to `xd://ast_edit`), so it is skipped and the
 * first real entry of `paths` is used instead. `local://` is unwrapped to its
 * workspace path.
 */
export function gateTargetPath(input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input) return undefined;
  const many = Array.isArray(input.paths) ? input.paths : [];
  for (const raw of [input.path, input.file_path, input.notebook_path, ...many]) {
    if (typeof raw !== 'string') continue;
    const candidate = raw.trim();
    if (!candidate) continue;
    if (candidate.startsWith('local://')) return candidate.slice('local://'.length);
    if (candidate.includes('://')) continue; // a device, not a file
    return candidate;
  }
  return undefined;
}

// A patch names its files in header lines ('*** Update File: src/a.ts').
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const PATCH_BEGIN = /^\*\*\* Begin Patch\s*$/m;

/** Every distinct file a patch touches, or [] when the text names none. */
export function patchTargets(text: string): string[] {
  return [...new Set([...text.matchAll(PATCH_HEADER)].map((m) => m[1].trim()).filter(Boolean))];
}

/**
 * The patch a tool carries, whatever the tool is called (apply_patch puts it in
 * patchText, patch or input). Only a real patch envelope counts, so text that
 * merely mentions a header is not mistaken for a write.
 */
export function toolPatch(input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input) return undefined;
  for (const v of [input.patchText, input.patch, input.input]) {
    if (typeof v === 'string' && PATCH_BEGIN.test(v) && patchTargets(v).length) return v;
  }
  return undefined;
}

/** The input key holding the command a tool is about to run, whatever the tool is called. */
export function toolCommandKey(input: Record<string, unknown> | undefined | null): 'command' | 'cmd' | undefined {
  if (!input) return undefined;
  for (const key of ['command', 'cmd'] as const) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return key;
  }
  return undefined;
}

/** The file a non-writing tool is about to read, whatever the tool is called. */
export function toolReadPath(input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input) return undefined;
  for (const v of [input.path, input.file_path, input.filePath]) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * The model pi reports for the command it is running, from PI_PROVIDER + PI_MODEL.
 * pi sets these per bash command from its live ctx.model and re-resolves them on a
 * model switch (dist/core/tools/bash.js; docs/environment-variables.md), so this is
 * the freshest source available to a hook. Returns `provider/model` when pi told us
 * both, else the bare PI_MODEL, else null.
 *
 * The provider is kept because settings.json splits the model across TWO keys
 * (defaultProvider + defaultModel), so a bare id alone is ambiguous — the same
 * `qwen3.8:27b` can exist under several providers.
 */
export function envModel(env: Record<string, string | undefined> | undefined | null): string | null {
  const model = (env?.PI_MODEL ?? '').trim();
  if (!model) return null;
  const provider = (env?.PI_PROVIDER ?? '').trim();
  return provider ? `${provider}/${model}` : model;
}

/** Assemble `provider/model` (or the bare id when no provider is known). */
function joinModel(provider: unknown, model: unknown): string | null {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return null;
  const p = typeof provider === 'string' ? provider.trim() : '';
  return p ? `${p}/${m}` : m;
}

/**
 * Read the model from pi's own session transcript — the record of which model
 * actually answered. Scans from the END so the newest signal wins, and a
 * `model_change` entry (written when the user switches mid-session) outranks
 * assistant messages before it. Pass a reader for tests.
 *
 * Cost is bounded: only the last 256KB of the file is read, and the result is
 * cached per file for a couple of seconds (see defaultDeps), so a burst of bash
 * calls does not re-read a transcript that only grows.
 */
export function readPiSessionModel(
  read: () => string = () => {
    const file = process.env.PI_SESSION_FILE;
    if (!file) return '';
    // statSync FIRST and check it is a regular file BEFORE opening. This runs
    // synchronously inside pi's own process, so opening a FIFO would block pi
    // outright (open() on a FIFO with no writer never returns) and a huge file
    // would be allocated into memory. Either way we return '' (a missed source),
    // never a wrong model.
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    const start = Math.max(0, st.size - 262_144);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      // Drop a leading partial line from the mid-file seek.
      return buf.toString('utf8').replace(/^[^\n]*\n/, '');
    } finally {
      fs.closeSync(fd);
    }
  },
): string | null {
  try {
    const text = read();
    if (!text) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a truncated tail or malformed line must not lose the whole read
      }
      if (entry?.type === 'model_change') {
        const found = joinModel(entry.provider, entry.modelId);
        if (found) return found;
        continue;
      }
      if (entry?.type === 'message' && entry.message?.role === 'assistant') {
        const found = joinModel(entry.message.provider, entry.message.model);
        if (found) return found;
      }
    }
    return null;
  } catch {
    return null; // never break the host on a transcript read
  }
}

/**
 * Read pi's configured model (`defaultModel`) from ~/.pi/agent/settings.json.
 * Returns the bare model id (e.g. "@cf/zai-org/glm-5.2") or null. Never throws —
 * a missing/unreadable/garbage file yields null. The reader is injectable for tests.
 *
 * LAST-RESORT source: this is pi's STARTUP model and it carries no provider, so it
 * is wrong after a model switch and ambiguous across providers.
 */
export function readPiDefaultModel(
  read: () => string = () => fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8'),
): string | null {
  try {
    const j = JSON.parse(read());
    const m = j && j.defaultModel;
    return m ? String(m) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model from the most reliable source, best first:
 *   0. ctx.model           — the live model pi hands every extension handler
 *                            (ExtensionContext.model, pi 1.4)
 *   1. env()               — PI_PROVIDER/PI_MODEL; set in the bash tool's child
 *                            shell, so usually absent in the extension's process
 *   2. ctx.getModel()      — older/internal context shapes
 *   3. lastSelected        — cached from a model_select event
 *   4. readTranscript()    — pi's session jsonl: the model that actually answered
 *   5. readDefault()       — settings.json defaultModel, the stale/ambiguous last resort
 *
 * Returns `provider/model` when the source knows a provider, else the bare id. The
 * hub strips router/provider prefixes when matching a model id
 * (packages/hub/src/util/modelMeta.ts `normaliseModelId`), so the qualified form
 * still classifies downstream.
 */
export function resolveModelSource(sources: {
  ctx: PiContext | undefined;
  lastSelected: string | null;
  readDefault: () => string | null;
  readTranscript?: () => string | null;
  env?: () => string | null;
}): string | null {
  const { ctx, lastSelected, readDefault } = sources;
  try {
    const live = ctx?.model;
    const fromLive = live ? joinModel(live.provider, live.id) : null;
    if (fromLive) return fromLive;
  } catch { /* fall through */ }
  try {
    const fromEnv = sources.env ? sources.env() : null;
    if (fromEnv) return fromEnv;
  } catch { /* fall through */ }
  try {
    const live = ctx && ctx.getModel ? ctx.getModel() : undefined;
    const fromCtx = live ? joinModel(live.provider, live.id) : null;
    if (fromCtx) return fromCtx;
  } catch { /* fall through */ }
  if (lastSelected) return lastSelected;
  try {
    const fromTranscript = sources.readTranscript ? sources.readTranscript() : null;
    if (fromTranscript) return fromTranscript;
  } catch { /* fall through */ }
  try {
    return readDefault();
  } catch {
    return null;
  }
}

/**
 * Append the deterministically-detected model to a PR reminder so the agent
 * reports the real model id + harness=pi instead of guessing. No-ops cleanly
 * when the model is unknown.
 */
export function composeReminder(baseMessage: string, model: string | null): string {
  if (!model) return baseMessage;
  return (
    `${baseMessage}\n\n[agenfk] Your model is deterministically detected as "${model}". ` +
    `When you call register_pr/update_pr_sizing, pass model = "${model}" and harness = "pi" ` +
    `(CLI: \`agenfk pr-register … --model ${model} --harness pi\`). Do not guess the model.`
  );
}

/**
 * Decide which `--model` value an agenfk PR command should carry, WITHOUT clobbering
 * a model the agent already reported correctly.
 *
 * The agent's own `--model` counts as agreement when it matches the detected model
 * on the artifact name — the suffix after the last `/`, the same axis the hub
 * matches on. So `qwen38-flashnext` satisfies a detected `coding4/qwen38-flashnext`
 * and vice versa, and no flags are appended at all. Only a CONTRADICTING value is
 * overridden (appended last so commander last-wins picks the detected model).
 *
 * Returns the model to inject, or null when the command needs no rewrite.
 */
export function preferredModelArg(command: string, model: string | null): string | null {
  if (!command || !model) return null;
  const reported = reportedModelArg(command);
  if (reported && modelSuffix(reported) === modelSuffix(model)) return null;
  return model;
}

/**
 * The artifact name a model id identifies: everything after the last `/`, lowercased.
 * The prefix names the route (`@cf/…` on Cloudflare Workers AI, `anthropic/…` on
 * OpenRouter), not the model — the same convention the hub matches on.
 */
function modelSuffix(id: string): string {
  const t = id.trim();
  const slash = t.lastIndexOf('/');
  return (slash >= 0 ? t.slice(slash + 1) : t).toLowerCase();
}

/**
 * The value of the last top-level `--model` in a command, or null when it has none.
 * Scans only OUTSIDE quotes (a `--model` inside a `--body` is prose, not a flag) and
 * only up to the first top-level shell operator (a `--model` in a later pipeline
 * stage belongs to that stage). The value is read as ONE shell word, so a quoted
 * value containing a space is taken whole.
 */
function reportedModelArg(command: string): string | null {
  const chars = [...command];
  const cut = topLevelOperator(command);
  let reported: string | null = null;
  let quote: string | null = null;
  let i = 0;
  while (i < cut) {
    const ch = chars[i];
    if (quote) {
      // Inside a quoted run: consume it, never match a flag in it.
      if (ch === '\\' && quote === '"') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (isFlagAt(chars, i, cut, '--model')) {
      const [value, end] = readShellWord(chars, i + '--model'.length, cut);
      reported = value.trim() || null; // last occurrence wins (commander semantics)
      i = end;
      continue;
    }
    i += 1;
  }
  return reported;
}

/** True when `--flag` starts at i as a whole flag (not a prefix like --modelname). */
function isFlagAt(chars: string[], i: number, cut: number, flag: string): boolean {
  if (i + flag.length > cut) return false;
  for (let k = 0; k < flag.length; k += 1) {
    if (chars[i + k] !== flag[k]) return false;
  }
  const after = chars[i + flag.length];
  return after === undefined || after === '=' || /\s/.test(after);
}

/**
 * Read one shell word starting at `from` (skipping leading spaces, honouring an
 * optional `=`, quotes and backslash escapes), stopping at whitespace, a top-level
 * operator, or `cut`. Returns the unquoted value and the index just past it.
 */
function readShellWord(chars: string[], from: number, cut: number): [string, number] {
  let j = from;
  if (chars[j] === '=') j += 1;
  while (j < cut && /\s/.test(chars[j])) j += 1;
  let value = '';
  let quote: string | null = null;
  while (j < cut) {
    const c = chars[j];
    if (quote) {
      if (c === '\\' && quote === '"') { j += 1; value += chars[j] ?? ''; j += 1; continue; }
      if (c === quote) { quote = null; j += 1; continue; }
      value += c; j += 1; continue;
    }
    if (c === '\\') { j += 1; value += chars[j] ?? ''; j += 1; continue; }
    if (c === '"' || c === "'") { quote = c; j += 1; continue; }
    if (/\s/.test(c) || SHELL_OPERATORS.has(c)) break;
    value += c; j += 1;
  }
  return [value, j];
}

const SHELL_OPERATORS = new Set(['|', ';', '&', '>', '<']);

/**
 * Index of the first TOP-LEVEL (unquoted) shell operator in a command, or its
 * length when there is none. Honours single/double quotes and backslash escapes,
 * and backs up over a file descriptor so `2>&1` is cut before the `2`.
 */
function topLevelOperator(command: string): number {
  const chars = [...command];
  let quote: string | null = null;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (SHELL_OPERATORS.has(ch)) {
      let cut = i;
      if (ch === '>' || ch === '<') {
        while (cut > 0 && /\d/.test(chars[cut - 1])) cut -= 1;
      }
      return cut;
    }
  }
  return chars.length;
}

/**
 * Force the deterministically-detected model onto an `agenfk pr create` /
 * `pr-register` / `pr-resize` command BEFORE it runs, so the agent cannot
 * misreport its model (weak harnesses guess wrong — e.g. pi/GLM reported
 * "claude-sonnet-4-5" while actually running glm-5.2). We append
 * `--model <model> --harness pi` as the LAST args of the agenfk command, so
 * commander's last-one-wins overrides any value the agent supplied. The flags
 * are inserted before the first top-level (unquoted) shell operator so a trailing
 * `| head` / `2>&1` still works, and `--body` text is never rewritten.
 *
 * No-ops (returns the command unchanged) when the model is unknown, or when the
 * command is not a leading `agenfk pr (create|-register|-resize)` invocation.
 */
export function injectDeterministicModel(command: string, model: string | null): string {
  if (!command || !model) return command;
  // The model is spliced UNQUOTED into a command pi runs through a real shell, and
  // it now comes from a free-form file (~/.pi/agent/settings.json). Allowlist the
  // characters a legitimate model id uses (e.g. "@cf/zai-org/glm-5.2",
  // "claude-opus-4-8") and refuse anything else, so shell metacharacters
  // (; | & $ ` > < (), whitespace, quotes) can never reach the rewritten command.
  if (!/^[\w.@:/-]+$/.test(model)) return command;
  // Must be the leading command (not piped-into / embedded / echoed).
  if (!/^\s*agenfk\s+pr(\s+create|-register|-resize)\b/.test(command)) return command;

  // Cut at the first top-level shell operator (shared with preferredModelArg, so
  // the two can never disagree about which `--model` is ours). This keeps the flags
  // as args of the agenfk command rather than after a pipe, and never splits an
  // escaped quote inside --body.
  const cut = topLevelOperator(command);

  const head = command.slice(0, cut).replace(/\s+$/, '');
  const tail = command.slice(cut); // shell operator + rest (or '')
  // Do not append a duplicate when the agent already reported this model.
  const toInject = preferredModelArg(command, model);
  if (!toInject) return command;
  const injected = `${head} --model ${toInject} --harness pi`;
  return tail ? `${injected} ${tail.replace(/^\s+/, '')}` : injected;
}

// ── Delegation to the shared decision scripts ────────────────────────────────

function runHookScript(script: string, argv: string[], stdin: unknown): any | null {
  // A resolved runtime, not process.execPath: on a Bun standalone host the latter
  // is the host binary and the spawn would re-enter it. Enforcing callers check
  // `hookRuntimeFor()` themselves and fail closed; this is the last guard.
  const runtime = hookRuntimeFor();
  if (!runtime) return null;
  try {
    const res = spawnSync(runtime, [path.join(HOOK_DIR, script), ...argv], {
      input: JSON.stringify(stdin),
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const out = (res.stdout || '').trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null; // never break the host on a hook failure
  }
}

export function defaultDeps(): PiExtensionDeps {
  // settings.json is read at most once per process — it is the last resort and
  // changes only when the user edits it by hand. The fresher sources are NOT
  // memoised that way: env is read per event (pi re-resolves it on every model
  // switch) and the transcript is re-read on a short TTL so a mid-session switch
  // is picked up instead of being cached wrong for the whole session.
  let cachedDefault: string | null | undefined;
  const readDefaultModel = () => {
    if (cachedDefault === undefined) cachedDefault = readPiDefaultModel();
    return cachedDefault;
  };

  const TRANSCRIPT_TTL_MS = 2_000;
  let transcriptCache: { at: number; file: string; value: string | null } | null = null;
  const readTranscriptModel = () => {
    const file = process.env.PI_SESSION_FILE;
    if (!file) return null;
    const now = Date.now();
    // The TTL cache is keyed on the FILE as well as the clock: pi switches this
    // variable when the session changes (/resume, /new, fork), and a cache that
    // ignored it would keep reporting the PREVIOUS session's model for the rest
    // of the TTL.
    if (transcriptCache && transcriptCache.file === file && now - transcriptCache.at < TRANSCRIPT_TTL_MS) {
      return transcriptCache.value;
    }
    const value = readPiSessionModel();
    transcriptCache = { at: now, file, value };
    return value;
  };

  return {
    gatekeeperVerdict: (filePath) => {
      if (!filePath) return null;
      // Fail closed: a write with no runtime is denied, not waved through.
      if (!hookRuntimeFor()) return { decision: 'block', reason: HOOK_RUNTIME_MISSING };
      return runHookScript('agenfk-gatekeeper.mjs', [], { tool: 'edit', tool_input: { file_path: filePath } });
    },
    // The enforcer blocks only the routes around the server (direct DB reads,
    // curl/wget to localhost); the agenfk CLI is always allowed. Bash and read
    // stay advisory when there is no runtime: a missing hook should not brick the
    // whole shell, only the workflow gate that the gatekeeper already enforces.
    enforcerVerdict: (command) =>
      command
        ? runHookScript('agenfk-mcp-enforcer.mjs', ['--client', 'pi'], { tool: 'Bash', tool_input: { command } })
        : null,
    readVerdict: (filePath) =>
      filePath
        ? runHookScript('agenfk-mcp-enforcer.mjs', ['--client', 'pi'], { tool: 'Read', tool_input: { file_path: filePath } })
        : null,
    prReminder: (command) =>
      command
        ? runHookScript('agenfk-pr-hook.mjs', ['--client', 'pi'], { args: { command } })
        : null,
    readDefaultModel,
    readTranscriptModel,
    readEnvModel: () => envModel(process.env),
    // Enforcing only when the policy says so: a missing runtime or script comes
    // back null, and the caller applies the unreachable rule to it.
    airlockVerdict: (request) => runHookScript('agenfk-airlock.mjs', [], request),
    readAirlockState: () => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agenfk', 'airlock-state.json'), 'utf8'));
        return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
      } catch {
        return null;
      }
    },
    isSandboxed: () => airlockSandboxed(),
  };
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function activate(pi: PiApi, deps: PiExtensionDeps = defaultDeps()): void {
  // Cache the most recent model_select id. resolveModelSource prefers the live
  // per-command env, then ctx.getModel(), then this cache, then the transcript,
  // and only then ~/.pi/agent/settings.json (deps.readDefaultModel).
  let lastSelectedModel: string | null = null;
  const modelFor = (ctx: PiContext | undefined) =>
    resolveModelSource({
      ctx,
      lastSelected: lastSelectedModel,
      readDefault: deps.readDefaultModel,
      readTranscript: deps.readTranscriptModel,
      env: deps.readEnvModel,
    });

  let lastSelectedProvider: string | null = null;
  pi.on('model_select', (event) => {
    try {
      const id = event?.model?.id;
      if (id) {
        lastSelectedModel = String(id);
        const provider = event?.model?.provider;
        lastSelectedProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : null;
      }
    } catch { /* ignore */ }
  });

  // Airlock wants the model as provider + id. Same sources, same order as
  // modelFor; a source that knows no provider is sent as a bare id rather than
  // split on a slash that belongs to the id (`@cf/zai-org/glm-5.2`).
  const liveModel = (live: PiModel | undefined): AirlockSessionModel | null => {
    const id = typeof live?.id === 'string' ? live.id.trim() : '';
    if (!id) return null;
    return { provider: typeof live?.provider === 'string' && live.provider.trim() ? live.provider.trim() : null, id };
  };
  /**
   * The session Airlock (and the agent's own agenfk calls) name: AGENFK_SESSION_ID when the
   * harness that started pi set one, else the session pi is on now (BUG 3afbbf7e: neither pi
   * nor the Airlock launcher sets the env, so every live dataset row went out with no session
   * and no card). Read once: pi's own export never stands in for a harness's (review C2).
   */
  const harnessSessionId = (process.env.AGENFK_SESSION_ID ?? '').trim();
  const sessionIdFor = (ctx: PiContext | undefined): string => {
    if (harnessSessionId) return harnessSessionId;
    try {
      const own = ctx?.sessionManager?.getSessionId?.();
      return typeof own === 'string' ? own.trim() : '';
    } catch {
      return '';
    }
  };

  const airlockModelFor = (ctx: PiContext | undefined): AirlockSessionModel | null => {
    try { const m = liveModel(ctx?.model); if (m) return m; } catch { /* next */ }
    try { const e = deps.readEnvModel(); if (e) return splitJoinedModel(e); } catch { /* next */ }
    try { const m = liveModel(ctx?.getModel?.()); if (m) return m; } catch { /* next */ }
    if (lastSelectedModel) return { provider: lastSelectedProvider, id: lastSelectedModel };
    try { const t = deps.readTranscriptModel(); if (t) return splitJoinedModel(t); } catch { /* next */ }
    try { const d = deps.readDefaultModel(); if (d) return { provider: null, id: d.trim() }; } catch { /* next */ }
    return null;
  };

  let airlockLastKnown: AirlockLastKnown | null = null;
  /** Airlock's word on one tool call: a block, or null to let it through. Never throws. */
  const airlockCheck = (event: PiEvent, ctx: PiContext | undefined): { block: true; reason: string } | null => {
    const ask = deps.airlockVerdict;
    const input = event?.input;
    if (!ask || !hasAirlockCapabilities(input)) return null;
    const readState = (): AirlockState | null => {
      try { return deps.readAirlockState ? deps.readAirlockState() : null; } catch { return null; }
    };
    // A fresh `off` needs no spawn (mode is policy-wide, whatever the model),
    // unless the server has since written a newer policy to the state file.
    if (airlockLastKnown?.mode === 'off' && Date.now() - airlockLastKnown.at < AIRLOCK_OFF_TTL_MS &&
      !airlockStateIsNewer(readState(), airlockLastKnown)) return null;
    const model = airlockModelFor(ctx);
    const modelKey = model ? `${model.provider ?? ''}/${model.id ?? ''}` : '';
    let result: AirlockResult | null = null;
    try {
      const sessionId = sessionIdFor(ctx);
      result = ask({
        client: 'pi',
        model,
        toolName: String(event?.toolName ?? ''),
        args: input as Record<string, unknown>,
        ...(sessionId ? { sessionId } : {}),
        ...(typeof ctx?.cwd === 'string' && ctx.cwd ? { cwd: ctx.cwd } : {}),
      });
    } catch { result = null; }
    if (result && result.status === 'ok' && result.verdict && typeof result.verdict.decision === 'string') {
      airlockLastKnown = {
        mode: String(result.mode), applies: result.applies === true,
        revision: result.revision, source: result.source, at: Date.now(), modelKey,
      };
      return airlockBlock(result.verdict);
    }
    // Unreachable, or the script never answered. The last answer counts only
    // for the model it was given for, while fresh, and while the state file
    // holds nothing newer; otherwise the state file decides.
    const known = airlockLastKnown && airlockLastKnown.modelKey === modelKey ? airlockLastKnown : null;
    const fallback = airlockWhenUnreachable(known, readState(), model);
    return fallback.block ? { block: true, reason: fallback.reason as string } : null;
  };

  /**
   * The launch gate: in enforce mode, a covered session outside the sandbox
   * has every tool call refused, whatever it carries. Per call, with the model
   * of that call, so a switch to a covered model is caught on the next one.
   * "Enforce and covered" is this process's last answer for that model, unless
   * the state file holds a newer policy, else the state file.
   */
  const airlockGate = (ctx: PiContext | undefined): { block: true; reason: string } | null => {
    const sandboxed = deps.isSandboxed;
    if (!sandboxed) return null;
    let state: AirlockState | null = null;
    try { state = deps.readAirlockState ? deps.readAirlockState() : null; } catch { state = null; }
    const model = airlockModelFor(ctx);
    const modelKey = model ? `${model.provider ?? ''}/${model.id ?? ''}` : '';
    const known = airlockLastKnown && airlockLastKnown.modelKey === modelKey ? airlockLastKnown : null;
    const enforcing = known && !airlockStateIsNewer(state, known)
      ? known.mode === 'enforce' && known.applies
      : !!state && state.mode === 'enforce' && airlockStateCovers(state, model);
    if (!enforcing) return null;
    // Probed only when the gate applies: the proof is a socket, once per process.
    let status: AirlockSandboxStatus;
    try {
      const s = sandboxed();
      status = typeof s === 'boolean' ? { sandboxed: s } : s;
    } catch { status = { sandboxed: false }; }
    return status.sandboxed ? null : { block: true, reason: airlockLaunchGateReason(status.reason) };
  };

  // #4 — load confirmation. On session_start, prove the extension loaded and that
  // pi's event bus dispatches to it (the open question on every pi upgrade). The
  // detected model rides along so this doubles as a model-resolution smoke test.
  pi.on('session_start', (_event, ctx) => {
    // Exported for every shell pi starts, so `agenfk gatekeeper` keys its note of the card to the
    // session Airlock names (BUG 3afbbf7e) - again at every start, resume or fork (review C2).
    // pi's own variable, ranked below Claude Code's by the gatekeeper, so a harness started from
    // pi's shell keeps its own (C3); and a Claude Code session pi itself was started from is not
    // its shells' session.
    try {
      const id = sessionIdFor(ctx);
      if (id) process.env.AGENFK_PI_SESSION_ID = id;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    } catch { /* never break the host */ }
    try {
      const model = modelFor(ctx);
      const suffix = model ? ` — model: ${model}` : '';
      ctx?.ui?.notify?.(`[agenfk] extension active (pi)${suffix}`, 'info');
    } catch { /* never break the host */ }
  });

  // #3 — block edits/writes with no active task, and the bash/read bypass routes.
  // Synchronous: the verdict comes from a blocking spawnSync, and returning it
  // synchronously avoids any chance of the tool slipping past on a later tick.
  pi.on('tool_call', (event, ctx) => {
    try {
      const name = event?.toolName;
      // Apart from the write tools, a tool is judged by what it carries, not its
      // name: plugin tools such as pi-patty-bg-tasks' bash_bg run commands too
      // (BUG dac2720a).
      const input = event?.input;
      const commandKey = toolCommandKey(input);
      const readPath = toolReadPath(input);
      const patch = toolPatch(input);
      if (patch !== undefined) {
        // A patch is gated by every file it touches, whatever the tool is called
        // (BUG 59d3ad7c): it names them in its text, not in a path argument.
        // An embedded session applies the patch in its own ctx.cwd, which need
        // not be this process's directory (where the hook would resolve it).
        const sessionDir = typeof ctx?.cwd === 'string' && ctx.cwd ? ctx.cwd : undefined;
        for (const target of patchTargets(patch)) {
          const filePath = sessionDir ? path.resolve(sessionDir, target) : target;
          const v = deps.gatekeeperVerdict(filePath);
          if (v && v.decision === 'block') return { block: true, reason: v.reason };
        }
      }
      if (GATED_WRITE_TOOLS.has(String(name))) {
        if (patch === undefined) {
          const v = deps.gatekeeperVerdict(gateTargetPath(input as Record<string, unknown> | undefined));
          if (v && v.decision === 'block') return { block: true, reason: v.reason };
        }
      } else {
        // A patch does not exempt a tool from the command and path checks.
        // A command and a path are checked independently: a tool carrying both
        // must not get its path through on the strength of a harmless command.
        if (input && commandKey) {
          const command = input[commandKey] as string;
          // Force the real model onto agenfk PR-registration commands BEFORE they run
          // so the pr.opened/pr.updated event can't carry a guessed model. Mutate
          // the key that holds the command (pi's supported way to modify tool
          // arguments), never a blank sibling the tool does not run.
          const rewritten = injectDeterministicModel(command, modelFor(ctx));
          if (rewritten !== command) input[commandKey] = rewritten;
          const v = deps.enforcerVerdict(command);
          if (v && v.decision === 'block') return { block: true, reason: v.reason };
        }
        if (readPath !== undefined) {
          const v = deps.readVerdict(readPath);
          if (v && v.decision === 'block') return { block: true, reason: v.reason };
        }
      }
      // Airlock last: the workflow checks above have had their say, so a
      // refused edit is reported as the workflow's, not the policy's.
      const airlock = airlockCheck(event, ctx);
      if (airlock) return airlock;
      const gate = airlockGate(ctx);
      if (gate) return gate;
    } catch { /* never break the host */ }
    return undefined;
  });

  // #1 — after a bash command, nudge for PR sizing with the real model injected.
  pi.on('tool_result', (event, ctx) => {
    try {
      if (event?.toolName !== 'bash') return;
      const command = event?.input?.command ?? event?.input?.cmd;
      const r = deps.prReminder(command);
      if (r && r.message) {
        const model = modelFor(ctx);
        pi.sendMessage(
          { customType: 'agenfk-pr', content: composeReminder(r.message, model), display: true },
          { deliverAs: 'steer', triggerTurn: false },
        );
      }
    } catch { /* never break the host */ }
  });
}
