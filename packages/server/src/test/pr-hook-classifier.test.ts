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
