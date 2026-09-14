/**
 * Is the framework's enforcement actually installed?
 *
 * `agenfk health` reported "All systems healthy" on a machine where nothing
 * about enforcement had been verified. Of its checks, two were about Opencode
 * and the rest were about the server, the database and the skills directory —
 * none looked at the enforcement surface of either client the team uses.
 *
 * That is the worst kind of green. The whole proposition of this framework is
 * that edits are gated: one PreToolUse hook blocks Edit/Write without an active
 * task, another blocks the direct-database and curl bypass routes. When they
 * are missing the agent still READS the rules and still BELIEVES it is
 * enforced — it just is not. Health saying "fine" turns a missing safeguard
 * into a confirmed one.
 *
 * Pure functions taking file CONTENTS rather than reading disk, so the cases
 * that matter — half-installed, renamed, registered on the wrong event — can be
 * written down instead of reproduced by hand on a real machine.
 */

/**
 * What Claude Code must have registered, and on which event.
 *
 * The event is part of the requirement, not decoration: a gatekeeper on
 * PostToolUse runs AFTER the edit it exists to prevent. The registration would
 * be there and the protection would not.
 */
export const REQUIRED_CLAUDE_HOOKS = ['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook'] as const;

const HOOK_EVENTS: Record<string, string> = {
  'agenfk-gatekeeper': 'PreToolUse',
  'agenfk-mcp-enforcer': 'PreToolUse',
  'agenfk-pr-hook': 'PostToolUse',
};

export interface EnforcementResult {
  readonly ok: boolean;
  /** Hooks not registered, or registered on the wrong event. */
  readonly missing: string[];
  /** Hooks registered whose executable is not on disk. */
  readonly missingBinaries: string[];
  readonly hint?: string;
}

/**
 * Does this command string invoke our hook?
 *
 * Matched on the executable NAME at a path boundary, because the installer
 * writes an absolute path and appends `.cmd` on Windows — pinning the exact
 * string it happens to produce today would report a correctly installed
 * machine as broken. Anchored at both ends of the name so
 * `agenfk-gatekeeper-disabled`, which is somebody else's script, does not
 * count as ours.
 */
function invokes(command: string, hook: string): boolean {
  const name = command.split(/[\s]+/)[0] ?? command;
  const base = name.split(/[/\\]/).pop() ?? name;
  return base === hook || base === `${hook}.cmd` || base === `${hook}.mjs`;
}

function commandsForEvent(settings: unknown, event: string): string[] {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return [];
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];
  const entries = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const list = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const command = (h as Record<string, unknown>)?.command;
      if (typeof command === 'string') out.push(command);
    }
  }
  return out;
}

/**
 * @param settings parsed ~/.claude/settings.json, or anything at all
 * @param binaryExists whether the hook's executable is present
 */
export function checkClaudeCodeEnforcement(
  settings: unknown,
  binaryExists: (hook: string) => boolean,
): EnforcementResult {
  const missing: string[] = [];
  const missingBinaries: string[] = [];

  for (const hook of REQUIRED_CLAUDE_HOOKS) {
    const registered = commandsForEvent(settings, HOOK_EVENTS[hook]).some(c => invokes(c, hook));
    if (!registered) { missing.push(hook); continue; }
    // Registered but absent is the half-installed state an upgrade produces:
    // settings.json still names the hook, ~/.local/bin no longer has it. What
    // Claude Code does then depends on its own error handling, and either way
    // the user's belief about what is enforced is wrong.
    if (!binaryExists(hook)) missingBinaries.push(hook);
  }

  const ok = missing.length === 0 && missingBinaries.length === 0;
  return {
    ok,
    missing,
    missingBinaries,
    // Naming what to run is the difference between a health check and an
    // alarm. "Enforcement incomplete" sends the user hunting.
    hint: ok ? undefined : 'agenfk integration install claude-code',
  };
}

/**
 * pi's extension, which is mechanical parity with the Claude Code hooks rather
 * than instructional rules — so its absence is the same class of problem, and
 * health never looked for it at all.
 */
export function checkPiEnforcement(extensionExists: boolean): EnforcementResult {
  return {
    ok: extensionExists,
    missing: extensionExists ? [] : ['~/.pi/agent/extensions/agenfk.ts'],
    missingBinaries: [],
    hint: extensionExists ? undefined : 'agenfk integration install pi',
  };
}
