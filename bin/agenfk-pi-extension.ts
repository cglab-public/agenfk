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
 *   • #2 Deterministic model — read the live model from ctx.getModel() (with
 *        model_select as a fallback) so the reminder carries the REAL model id +
 *        harness=pi instead of the agent guessing it (the recurring "reported the
 *        wrong model id" bug).
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
  // The model pi is configured to run, read from ~/.pi/agent/settings.json. This
  // is the ONLY reliable source in live pi: ctx.getModel() is often undefined and
  // model_select does not fire for the config-default model, so without this the
  // model never reaches the PR reminder / command rewrite.
  readDefaultModel: () => string | null;
}

const HOOK_DIR = path.join(os.homedir(), '.agenfk', 'bin');

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Read pi's configured model (`defaultModel`) from ~/.pi/agent/settings.json.
 * Returns the bare model id (e.g. "@cf/zai-org/glm-5.2") or null. Never throws —
 * a missing/unreadable/garbage file yields null. The reader is injectable for tests.
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
 * Resolve the BARE model id (not provider/id) from the most reliable source:
 *   1. ctx.getModel().id   — the live model, when pi exposes it
 *   2. lastSelected        — cached from a model_select event
 *   3. readDefault()       — ~/.pi/agent/settings.json defaultModel (the live-pi
 *                            fallback, since 1 & 2 are usually unavailable there)
 * Bare id keeps reporting consistent with settings.json and the claude-code
 * convention (e.g. "claude-opus-4-8"), avoiding a redundant provider prefix.
 */
export function resolveModelId(
  ctx: PiContext | undefined,
  lastSelected: string | null,
  readDefault: () => string | null = readPiDefaultModel,
): string | null {
  const live = ctx && ctx.getModel ? ctx.getModel() : undefined;
  if (live && live.id) return String(live.id);
  if (lastSelected) return lastSelected;
  return readDefault();
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

  // Find the first top-level shell operator, honoring single/double quotes and
  // backslash escapes, so we insert the flags as args of the agenfk command
  // rather than after a pipe and never split an escaped quote inside --body.
  let quote: string | null = null;
  let cut = command.length;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      // In double quotes (and unquoted) a backslash escapes the next char; in
      // single quotes a backslash is literal (no escaping), per POSIX shell.
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { i += 1; continue; } // escaped char outside quotes
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '>' || ch === '<') {
      cut = i;
      // A redirect can carry a leading file descriptor (e.g. `2>&1`): back up over
      // those digits so we cut before the fd, not in the middle of the operator.
      if (ch === '>' || ch === '<') {
        while (cut > 0 && /\d/.test(command[cut - 1])) cut -= 1;
      }
      break;
    }
  }

  const head = command.slice(0, cut).replace(/\s+$/, '');
  const tail = command.slice(cut); // shell operator + rest (or '')
  const injected = `${head} --model ${model} --harness pi`;
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
  // settings.json is read at most once per process: in live pi this is consulted
  // on most bash ops (getModel()/model_select are usually unavailable), and the
  // file rarely changes mid-session — an interactive model switch fires
  // model_select, whose cached id takes precedence over this fallback anyway.
  let cachedDefault: string | null | undefined;
  const readDefaultModel = () => {
    if (cachedDefault === undefined) cachedDefault = readPiDefaultModel();
    return cachedDefault;
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
  };
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function activate(pi: PiApi, deps: PiExtensionDeps = defaultDeps()): void {
  // Cache the most recent model_select id (bare). resolveModelId prefers the live
  // ctx.getModel(), then this cache, then ~/.pi/agent/settings.json (deps.readDefaultModel).
  let lastSelectedModel: string | null = null;
  const modelFor = (ctx: PiContext | undefined) =>
    resolveModelId(ctx, lastSelectedModel, deps.readDefaultModel);

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
