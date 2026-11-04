#!/usr/bin/env node
/**
 * AgEnFK Airlock — the PreToolUse hook for Claude Code and Codex (GH-356).
 *
 * Inside the Airlock sandbox (AGENFK_AIRLOCK_SANDBOX is claude or codex) every tool call that carries
 * a command, a local path or a URL is judged through the shared ~/.agenfk/bin/agenfk-airlock.mjs, as
 * pi's and OpenCode's are; a deny, or a call that needs a person's approval, is answered with a
 * PreToolUse deny (both clients read hookSpecificOutput.permissionDecision).
 *
 * Outside the sandbox it does nothing, whatever the policy says: unlike pi and OpenCode, running
 * Claude Code or Codex in Airlock is not required (user decision, GH-356), so there is no launch gate.
 *
 * Claude Code gets this hook from the launcher (claude --settings); Codex from ~/.codex/hooks.json,
 * where the installer registers it by a path that is the same inside the machine.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/** The sandbox markers this hook judges for: the launcher sets one per client. */
const JUDGED_CLIENTS = new Set(['claude', 'codex']);

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A tool call's input as the arguments the server judges: Claude's and Codex's keys are already its keys. */
export function argsOfToolInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

async function loadAirlock() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agenfk-airlock.mjs');
  try { return await import(pathToFileURL(script).href); } catch { return null; }
}

/**
 * The hook's answer to one PreToolUse call: a deny, or null to let it through.
 * `airlock` (the shared script's exports) and `stateFile` are given by tests.
 */
export async function judgeHookCall(input, { env = process.env, airlock, stateFile } = {}) {
  const client = env.AGENFK_AIRLOCK_SANDBOX;
  if (!JUDGED_CLIENTS.has(client)) return null;
  const a = airlock ?? await loadAirlock();
  if (!a) {
    // The shared script is missing in the machine: the install is broken. Refuse while the policy enforces.
    let mode;
    try { mode = JSON.parse(fs.readFileSync(stateFile ?? '', 'utf8'))?.mode; } catch { mode = undefined; }
    return mode === 'enforce' ? deny('[agenfk airlock] agenfk-airlock.mjs is missing in this machine, and the Airlock policy enforces, so this tool call is refused. Reinstall AgEnFK (agenfk upgrade).') : null;
  }
  const args = argsOfToolInput(input?.tool_input);
  if (!a.hasCapabilities(args)) return null;
  const model = a.sessionModel(env.AGENFK_AIRLOCK_MODEL ?? null);
  const sessionId = text(input?.session_id);
  const cwd = text(input?.cwd);
  const result = await a.requestVerdict({
    client,
    model,
    toolName: String(input?.tool_name ?? ''),
    args,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  });
  if (result?.status === 'ok' && result.verdict) {
    const message = a.blockMessage(result.verdict);
    return message ? deny(message) : null;
  }
  // The shared rule: block only when the policy last known enforces and covers this session.
  const fallback = a.decideWhenUnreachable(null, stateFile ?? a.defaultStateFile(), { client, model });
  return fallback.block ? deny(fallback.reason) : null;
}

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch { return false; }
})();

if (isMain) {
  // Outside the sandbox: nothing to read, nothing to say.
  if (!JUDGED_CLIENTS.has(process.env.AGENFK_AIRLOCK_SANDBOX)) process.exit(0);
  (async () => {
    let input = null;
    try { input = JSON.parse(await readStdin()); } catch { input = null; }
    const out = await judgeHookCall(input);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  })().catch(() => process.exit(0));
}
