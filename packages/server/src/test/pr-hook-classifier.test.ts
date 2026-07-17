import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
// Importing the .mjs hook script directly. Pure helpers are exported by name.
// @ts-ignore — .mjs has no .d.ts; the helpers are JS functions.
import { classifyTrigger, buildDirective } from '../../../../bin/agenfk-pr-hook.mjs';

describe('classifyTrigger', () => {
  it('detects gh pr create', () => {
    expect(classifyTrigger('gh pr create --title foo --body bar')).toEqual({ kind: 'open' });
    expect(classifyTrigger("gh   pr   create --fill")).toEqual({ kind: 'open' });
  });

  it('detects git push and extracts branch when present', () => {
    expect(classifyTrigger('git push -u origin feature/x')).toEqual({ kind: 'push', branch: 'feature/x' });
    expect(classifyTrigger('git push origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD' });
    expect(classifyTrigger('git push')).toEqual({ kind: 'push', branch: undefined });
  });

  it('returns null for unrelated commands', () => {
    expect(classifyTrigger('ls -la')).toBeNull();
    expect(classifyTrigger('git status')).toBeNull();
    expect(classifyTrigger('gh pr view 123')).toBeNull();
  });

  it('handles multiline / leading whitespace', () => {
    expect(classifyTrigger('  gh pr create')).toEqual({ kind: 'open' });
  });
});

describe('buildDirective', () => {
  const message = 'You just opened PR #N. Call register_pr(...).';

  it('claude-code: emits additionalContext', () => {
    expect(buildDirective('claude-code', message)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    });
  });

  it('codex: emits decision/reason envelope', () => {
    expect(buildDirective('codex', message)).toEqual({
      decision: 'continue',
      reason: message,
    });
  });

  it('gemini: emits context injection', () => {
    expect(buildDirective('gemini', message)).toEqual({
      decision: 'continue',
      context: message,
    });
  });

  it('cursor: emits permission/output shape', () => {
    expect(buildDirective('cursor', message)).toEqual({
      permission: 'allow',
      userMessage: message,
    });
  });

  it('opencode: returns shape consumable by tool.execute.after plugin', () => {
    expect(buildDirective('opencode', message)).toEqual({
      message,
    });
  });

  it('unknown client: falls back to a generic shape', () => {
    expect(buildDirective('mystery', message)).toEqual({ message });
  });
});

describe('runtime command extraction', () => {
  const hookPath = path.resolve(__dirname, '../../../../bin/agenfk-pr-hook.mjs');

  it('detects Codex shell payloads that use cmd instead of command', () => {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'codex'], {
      input: JSON.stringify({ tool_input: { cmd: 'gh pr create --title fix' } }),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('register_pr');
  });

  it('detects OpenCode payloads that use args.command', () => {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'opencode'], {
      input: JSON.stringify({ args: { command: 'git push' } }),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('update_pr_sizing');
  });
});

// ── Segment-aware trigger detection (CGLAB-11) ───────────────────────────────
// The original classifier anchored ^gh pr create / ^git push on the WHOLE
// command, so compound and env-prefixed invocations never nudged the agent to
// register the PR — and pr.opened silently never fired for those flows.
describe('classifyTrigger — compound and env-prefixed commands', () => {
  it('detects gh pr create after a cd', () => {
    expect(classifyTrigger('cd /repo && gh pr create --fill')).toEqual({ kind: 'open' });
  });

  it('detects gh pr create behind env assignments', () => {
    expect(classifyTrigger('GH_TOKEN=xyz gh pr create --title t')).toEqual({ kind: 'open' });
    expect(classifyTrigger('A=1 B="two words" gh pr create')).toEqual({ kind: 'open' });
  });

  it('detects git push inside a chain and still extracts the branch', () => {
    expect(classifyTrigger('git add -A && git commit -m "x" && git push -u origin feat/y'))
      .toEqual({ kind: 'push', branch: 'feat/y' });
  });

  it('detects segments split by ; | and newlines', () => {
    expect(classifyTrigger('echo hi; gh pr create')).toEqual({ kind: 'open' });
    expect(classifyTrigger('gh pr create 2>&1 | tail -3')).toEqual({ kind: 'open' });
    expect(classifyTrigger('git fetch\ngit push origin main')).toEqual({ kind: 'push', branch: 'main' });
  });

  it('prefers the open trigger when a chain contains both push and create', () => {
    expect(classifyTrigger('git push -u origin feat/z && gh pr create --fill')).toEqual({ kind: 'open' });
  });

  it('does NOT fire on the words inside quoted strings', () => {
    expect(classifyTrigger('git commit -m "gh pr create later"')).toBeNull();
    expect(classifyTrigger("echo 'run git push when ready'")).toBeNull();
    expect(classifyTrigger('git commit -m "a && gh pr create"')).toBeNull();
  });

  it('still returns null for unrelated compound commands', () => {
    expect(classifyTrigger('cd /repo && npm test && ls')).toBeNull();
    expect(classifyTrigger('gh pr view 12 && gh pr checks 12')).toBeNull();
  });
});

describe('classifyTrigger — shell-semantics edge cases (adversarial review)', () => {
  it("handles the '\\'' apostrophe idiom in commit messages", () => {
    expect(classifyTrigger("git commit -m 'it'\\''s done' && git push origin main"))
      .toEqual({ kind: 'push', branch: 'main' });
  });

  it('2>&1 stays inside its segment and never becomes the branch', () => {
    expect(classifyTrigger('git push origin main 2>&1')).toEqual({ kind: 'push', branch: 'main' });
    expect(classifyTrigger('git push -u origin feat/x 2>&1 | tail -3')).toEqual({ kind: 'push', branch: 'feat/x' });
  });

  it('heredoc bodies cannot trigger (swallowed into their segment)', () => {
    expect(classifyTrigger('git commit -F- <<EOF\nsubject\ngit push origin main\nEOF')).toBeNull();
  });

  it('escaped backslash before a closing double quote does not desync quoting', () => {
    expect(classifyTrigger('echo "a\\\\" && gh pr create')).toEqual({ kind: 'open' });
  });
});
