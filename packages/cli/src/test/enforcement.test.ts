/**
 * @vitest-environment node
 *
 * Checking that the framework's enforcement is actually installed.
 *
 * `agenfk health` printed "All systems healthy" on a machine where none of it
 * was verified. Of its five checks, two were about Opencode and three were
 * about the server, the database and the skills directory — none looked at the
 * enforcement surface of either client the team actually uses.
 *
 * That is the worst kind of green. The whole proposition of this framework is
 * that edits are gated: a PreToolUse hook blocks Edit/Write without an active
 * task, another blocks the direct-database and curl bypass routes. If those are
 * missing, the agent still *reads* the rules and still *believes* it is
 * enforced, but nothing stops it — and health said everything was fine.
 *
 * These are pure functions taking the file contents rather than reading disk,
 * so the cases that matter (half-installed, renamed, wrong event) can be
 * written down instead of being reproduced by hand on a real machine.
 */
import { describe, it, expect } from 'vitest';
import {
  checkClaudeCodeEnforcement,
  checkPiEnforcement,
  REQUIRED_CLAUDE_HOOKS,
} from '../enforcement';

const hook = (command: string, matcher: string) => ({
  matcher,
  hooks: [{ type: 'command', command }],
});

/** What a correctly installed ~/.claude/settings.json looks like. */
const fullSettings = {
  hooks: {
    PreToolUse: [
      hook('agenfk-gatekeeper', 'Edit|Write|NotebookEdit'),
      hook('agenfk-mcp-enforcer', 'Bash|Read'),
    ],
    PostToolUse: [hook('agenfk-pr-hook', 'Bash')],
  },
};

describe('Claude Code enforcement', () => {
  it('passes when every hook is registered', () => {
    const result = checkClaudeCodeEnforcement(fullSettings, () => true);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('names the hook that is missing rather than just failing', () => {
    // "Enforcement incomplete" sends the user hunting. Naming the hook is the
    // difference between a health check and an alarm.
    const settings = { hooks: { PreToolUse: [hook('agenfk-gatekeeper', 'Edit|Write')] } };
    const result = checkClaudeCodeEnforcement(settings, () => true);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('agenfk-mcp-enforcer');
    expect(result.missing).not.toContain('agenfk-gatekeeper');
  });

  it('fails when the settings file has no hooks at all', () => {
    // The state this machine was actually in for agenfk-run-hook, and the
    // state a fresh install is in before `agenfk integration install`.
    const result = checkClaudeCodeEnforcement({}, () => true);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...REQUIRED_CLAUDE_HOOKS]);
  });

  it('fails when the hook is registered but its binary is gone', () => {
    // The half-installed case an upgrade produces: settings.json still names
    // the hook, ~/.local/bin no longer has it. Claude Code then fails the hook
    // open or closed depending on its own error handling, and either way the
    // user's belief about what is enforced is wrong.
    const result = checkClaudeCodeEnforcement(fullSettings, () => false);
    expect(result.ok).toBe(false);
    expect(result.missingBinaries).toContain('agenfk-gatekeeper');
  });

  it('does not accept a hook registered on the wrong event', () => {
    // A gatekeeper on PostToolUse runs AFTER the edit it was supposed to
    // prevent. The registration exists, the protection does not.
    const settings = {
      hooks: {
        PostToolUse: [
          hook('agenfk-gatekeeper', 'Edit|Write|NotebookEdit'),
          hook('agenfk-mcp-enforcer', 'Bash|Read'),
          hook('agenfk-pr-hook', 'Bash'),
        ],
      },
    };
    const result = checkClaudeCodeEnforcement(settings, () => true);
    expect(result.missing).toContain('agenfk-gatekeeper');
  });

  it('recognises the hook whatever path it was installed at', () => {
    // The installer writes an absolute path, and on Windows a .cmd. Matching
    // the exact string the installer happens to produce today would report a
    // correctly installed machine as broken.
    const settings = {
      hooks: {
        PreToolUse: [
          hook('/Users/someone/.local/bin/agenfk-gatekeeper', 'Edit|Write|NotebookEdit'),
          hook('C:\\Users\\someone\\.local\\bin\\agenfk-mcp-enforcer.cmd', 'Bash|Read'),
        ],
        PostToolUse: [hook('/Users/someone/.local/bin/agenfk-pr-hook', 'Bash')],
      },
    };
    expect(checkClaudeCodeEnforcement(settings, () => true).ok).toBe(true);
  });

  it('is not fooled by a hook whose name merely contains one of ours', () => {
    // `my-agenfk-gatekeeper-wrapper` is somebody else's script. Accepting it
    // would report enforcement that is not ours and may not gate anything.
    const settings = {
      hooks: { PreToolUse: [hook('agenfk-gatekeeper-disabled', 'Edit|Write')] },
    };
    expect(checkClaudeCodeEnforcement(settings, () => true).missing).toContain('agenfk-gatekeeper');
  });

  it('survives a settings file that is not the shape it expects', () => {
    // Hand-edited, or written by a newer Claude Code. A health check that
    // throws is worse than one that reports a problem.
    for (const junk of [null, [], 'text', 42, { hooks: 'nope' }, { hooks: { PreToolUse: 'nope' } }]) {
      expect(() => checkClaudeCodeEnforcement(junk, () => true)).not.toThrow();
      expect(checkClaudeCodeEnforcement(junk, () => true).ok).toBe(false);
    }
  });
});

describe('pi enforcement', () => {
  it('passes when the extension is installed', () => {
    // ~/.pi/agent/extensions/agenfk.ts. Per the README this is mechanical
    // parity with the Claude Code hooks, not instructional rules — so its
    // absence is the same class of problem, and health never looked.
    expect(checkPiEnforcement(true).ok).toBe(true);
  });

  it('fails when it is not', () => {
    const result = checkPiEnforcement(false);
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/agenfk integration install/i);
  });
});

describe('what the check refuses to do', () => {
  it('never reports healthy for a client it could not read', () => {
    // The failure mode that produced this card: something unverifiable being
    // presented as fine. "Not checked" must not look like "OK".
    expect(checkClaudeCodeEnforcement(null, () => true).ok).toBe(false);
  });
});
