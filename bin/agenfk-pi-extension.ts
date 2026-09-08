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
  input?: { command?: string; cmd?: string; path?: string; file_path?: string; [k: string]: unknown };
  model?: PiModel;
  [k: string]: unknown;
}
interface PiUi { notify?: (message: string, type?: 'info' | 'warning' | 'error') => void }
interface PiContext { getModel?: () => PiModel | undefined; ui?: PiUi }
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
  prReminder: (command: string | undefined) => ReminderResult | null;
  // pi's STARTUP model from ~/.pi/agent/settings.json. LAST resort: it carries no
  // provider and goes stale on a model switch, so the sources below outrank it.
  readDefaultModel: () => string | null;
  // The model that actually answered, from pi's session transcript (PI_SESSION_FILE).
  readTranscriptModel: () => string | null;
  // The model pi attributes to the command being run (PI_PROVIDER/PI_MODEL).
  readEnvModel: () => string | null;
}

const HOOK_DIR = path.join(os.homedir(), '.agenfk', 'bin');

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
 *   0. env()               — PI_PROVIDER/PI_MODEL, which pi re-resolves per command
 *   1. ctx.getModel()      — the live model, when pi exposes it (rare in live pi)
 *   2. lastSelected        — cached from a model_select event
 *   3. readTranscript()    — pi's session jsonl: the model that actually answered
 *   4. readDefault()       — settings.json defaultModel, the stale/ambiguous last resort
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
  try {
    // process.execPath is the Node binary pi itself is running under — more
    // reliable than 'node' from PATH (pi may be launched with a minimal PATH).
    const res = spawnSync(process.execPath, [path.join(HOOK_DIR, script), ...argv], {
      input: JSON.stringify(stdin),
      encoding: 'utf8',
      timeout: 2000,
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
    gatekeeperVerdict: (filePath) =>
      filePath
        ? runHookScript('agenfk-gatekeeper.mjs', [], { tool: 'edit', tool_input: { file_path: filePath } })
        : null,
    // Pass --client pi so the enforcer applies only the client-agnostic blocks
    // (direct DB reads, curl/wget to localhost) and skips the Claude-Code-specific
    // CLI-state-query rule — pi is CLI-first, so `agenfk list` is intended there.
    enforcerVerdict: (command) =>
      command
        ? runHookScript('agenfk-mcp-enforcer.mjs', ['--client', 'pi'], { tool: 'Bash', tool_input: { command } })
        : null,
    prReminder: (command) =>
      command
        ? runHookScript('agenfk-pr-hook.mjs', ['--client', 'pi'], { args: { command } })
        : null,
    readDefaultModel,
    readTranscriptModel,
    readEnvModel: () => envModel(process.env),
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

  pi.on('model_select', (event) => {
    try { const id = event?.model?.id; if (id) lastSelectedModel = String(id); } catch { /* ignore */ }
  });

  // #4 — load confirmation. On session_start, prove the extension loaded and that
  // pi's event bus dispatches to it (the open question on every pi upgrade). The
  // detected model rides along so this doubles as a model-resolution smoke test.
  pi.on('session_start', (_event, ctx) => {
    try {
      const model = modelFor(ctx);
      const suffix = model ? ` — model: ${model}` : '';
      ctx?.ui?.notify?.(`[agenfk] extension active (pi)${suffix}`, 'info');
    } catch { /* never break the host */ }
  });

  // #3 — block edits/writes with no active task, and forbidden bash bypass routes.
  // Synchronous: the verdict comes from a blocking spawnSync, and returning it
  // synchronously avoids any chance of the tool slipping past on a later tick.
  pi.on('tool_call', (event, ctx) => {
    try {
      const name = event?.toolName;
      if (name === 'edit' || name === 'write') {
        const filePath = event?.input?.path ?? event?.input?.file_path;
        const v = deps.gatekeeperVerdict(filePath);
        if (v && v.decision === 'block') return { block: true, reason: v.reason };
      } else if (name === 'bash') {
        const command = event?.input?.command ?? event?.input?.cmd;
        // Force the real model onto agenfk PR-registration commands BEFORE they run
        // so the pr.opened/pr.updated event can't carry a guessed model. Mutate
        // event.input in place (pi's supported way to modify tool arguments).
        const model = modelFor(ctx);
        if (event?.input && typeof command === 'string') {
          const rewritten = injectDeterministicModel(command, model);
          if (rewritten !== command) {
            if ('command' in event.input) event.input.command = rewritten;
            else if ('cmd' in event.input) event.input.cmd = rewritten;
          }
        }
        const v = deps.enforcerVerdict(command);
        if (v && v.decision === 'block') return { block: true, reason: v.reason };
      }
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
