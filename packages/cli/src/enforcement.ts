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

type RequiredHook = typeof REQUIRED_CLAUDE_HOOKS[number];

/**
 * Where each hook must be registered, and what it must match.
 *
 * The MATCHER is part of the requirement for exactly the same reason the event
 * is: a gatekeeper registered on PreToolUse with `matcher: "Bash"` never fires
 * on an edit, so nothing is gated — and reporting that as healthy is the
 * failure this whole module exists to prevent. It was missed the first time
 * because the tests passed a realistic matcher and the code never read it.
 *
 * Keyed by the required-hook tuple, so adding a hook without describing it is a
 * compile error rather than a check that silently reports it missing on every
 * healthy machine.
 */
const HOOK_CONTRACT: Record<RequiredHook, { event: string; mustMatch: string[] }> = {
  // The tools that edit. If the matcher misses one, that one is ungated.
  'agenfk-gatekeeper': { event: 'PreToolUse', mustMatch: ['Edit', 'Write', 'NotebookEdit'] },
  // The bypass routes: reading the database directly, curling the server.
  'agenfk-mcp-enforcer': { event: 'PreToolUse', mustMatch: ['Bash', 'Read'] },
  'agenfk-pr-hook': { event: 'PostToolUse', mustMatch: ['Bash'] },
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
  // Tokens, not the first word. Every step here is a form the installer or a
  // real machine actually produces, and each one used to report a correctly
  // configured machine as broken:
  //
  //   - a HOME with a space (`C:\Users\John Smith\...`), written unquoted, so
  //     splitting on whitespace yielded `C:\Users\John`
  //   - a leading space, which made the first token empty
  //   - `node /path/agenfk-gatekeeper.mjs`, which is how the Windows shim and
  //     the pi extension invoke the same scripts
  //   - a quoted path, which is what anyone fixing the first case by hand writes
  //
  // So: look at every token, strip quotes, and compare the last path segment.
  // Anchored at both ends of the name, so `agenfk-gatekeeper-disabled` —
  // somebody else's script — still does not count as ours.
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some(raw => {
    const unquoted = raw.replace(/^["']|["']$/g, '');
    const base = unquoted.split(/[/\\]/).pop() ?? unquoted;
    return base === hook || base === `${hook}.cmd` || base === `${hook}.mjs`;
  });
}

/** Does this matcher cover every tool the hook has to gate? */
function covers(matcher: unknown, mustMatch: string[]): boolean {
  if (typeof matcher !== 'string' || !matcher) return false;
  const alternatives = matcher.split('|').map(m => m.trim());
  return mustMatch.every(tool => alternatives.includes(tool));
}

/** Commands registered for an event whose matcher covers the required tools. */
function commandsForEvent(settings: unknown, event: string, mustMatch: string[]): string[] {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return [];
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];
  const entries = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    // A matcher that does not cover the tools is a registration that never
    // fires for them.
    if (!covers((entry as Record<string, unknown>).matcher, mustMatch)) continue;
    const list = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const hook = h as Record<string, unknown>;
      // `type: "prompt"` never executes as a command, so it gates nothing.
      if (hook?.type !== 'command') continue;
      if (typeof hook.command === 'string') out.push(hook.command);
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
    const contract = HOOK_CONTRACT[hook];
    const registered = commandsForEvent(settings, contract.event, contract.mustMatch)
      .some(c => invokes(c, hook));
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
    /*
     * Two different problems need two different commands, and naming the wrong
     * one is worse than naming none: the user runs it, nothing changes, and
     * health reports the identical failure.
     *
     * `agenfk integration install claude-code` resolves to `--only=claude`,
     * and the block that writes ~/.local/bin is skipped under `--only` — so it
     * fixes a missing REGISTRATION and cannot fix a missing BINARY.
     */
    hint: ok
      ? undefined
      : missingBinaries.length > 0
        ? 'npx agenfk@latest    (a scoped integration install does not write the hook binaries)'
        : 'agenfk integration install claude-code',
  };
}

/**
 * pi's extension, which is mechanical parity with the Claude Code hooks rather
 * than instructional rules — so its absence is the same class of problem, and
 * health never looked for it at all.
 */
export function checkPiEnforcement(
  extensionExists: boolean,
  scriptExists: (script: string) => boolean,
): EnforcementResult {
  const missing = extensionExists ? [] : ['~/.pi/agent/extensions/agenfk.ts'];
  /*
   * The extension is a delegator, not the enforcement itself: every decision
   * goes to ~/.agenfk/bin/*.mjs, and its runner returns null on a spawn
   * failure so as never to break the host. Extension present + scripts gone
   * means every edit is allowed, silently — the same half-installed state the
   * Claude check catches, which this one used to report as healthy.
   */
  const missingBinaries = extensionExists
    ? PI_DELEGATES.filter(script => !scriptExists(script))
    : [];
  return {
    ok: missing.length === 0 && missingBinaries.length === 0,
    missing,
    missingBinaries,
    /*
     * NOT `agenfk integration install pi`. That command does not exist — pi is
     * in neither alias list and the CLI exits with "Unknown integration: pi".
     * Only a full, un-scoped installer run ships the extension.
     */
    hint: missing.length === 0 && missingBinaries.length === 0
      ? undefined
      : 'npx agenfk@latest    (pi is not a scoped integration; it ships with a full install)',
  };
}

/** What the pi extension actually calls. Absent, pi fails open. */
export const PI_DELEGATES = ['agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs'] as const;
