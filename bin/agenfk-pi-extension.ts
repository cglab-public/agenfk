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
 *
 * Decision logic is delegated to the same ~/.agenfk/bin/*.mjs scripts every other
 * client uses, so there is a single source of truth. The only natively-pi parts
 * are model capture (a spawned script cannot see pi's ctx) and message injection.
 *
 * Verified against the pi 0.79.10 extension API:
 *   - handlers are (event, ctx) => …            (ExtensionHandler<E,R>)
 *   - tool_call blocks via return { block, reason }   (ToolCallEventResult)
 *   - ctx.getModel(): Model | undefined          (ExtensionContextActions)
 *   - pi.sendMessage(msg, { deliverAs, triggerTurn })
 *
 * Every handler is wrapped so a failure can never break the host agent.
 */

import { spawnSync } from 'node:child_process';
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
interface PiContext { getModel?: () => PiModel | undefined }
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
}

const HOOK_DIR = path.join(os.homedir(), '.agenfk', 'bin');

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Format a pi Model ({ provider, id }) into a `provider/id` string. */
export function formatModel(model: any): string | null {
  if (!model || typeof model !== 'object') return null;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  if (model.id) return String(model.id);
  return null;
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
  };
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function activate(pi: PiApi, deps: PiExtensionDeps = defaultDeps()): void {
  // Fallback model source: ctx.getModel() is authoritative, but cache the most
  // recent model_select in case getModel() is unavailable at reminder time.
  let lastSelectedModel: string | null = null;

  pi.on('model_select', (event) => {
    try { const m = formatModel(event?.model); if (m) lastSelectedModel = m; } catch { /* ignore */ }
  });

  // #3 — block edits/writes with no active task, and forbidden bash bypass routes.
  // Synchronous: the verdict comes from a blocking spawnSync, and returning it
  // synchronously avoids any chance of the tool slipping past on a later tick.
  pi.on('tool_call', (event) => {
    try {
      const name = event?.toolName;
      if (name === 'edit' || name === 'write') {
        const filePath = event?.input?.path ?? event?.input?.file_path;
        const v = deps.gatekeeperVerdict(filePath);
        if (v && v.decision === 'block') return { block: true, reason: v.reason };
      } else if (name === 'bash') {
        const command = event?.input?.command ?? event?.input?.cmd;
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
        const model = formatModel(ctx?.getModel?.()) || lastSelectedModel;
        pi.sendMessage(
          { customType: 'agenfk-pr', content: composeReminder(r.message, model), display: true },
          { deliverAs: 'steer', triggerTurn: false },
        );
      }
    } catch { /* never break the host */ }
  });
}
