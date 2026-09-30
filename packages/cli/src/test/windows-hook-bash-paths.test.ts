/**
 * Issue #192 — on Windows, Claude Code runs hook commands through Git Bash, which
 * eats the backslashes of an unquoted `C:\Users\x\.local\bin\agenfk-*.cmd` path
 * ("command not found", non-blocking, so the guard is silently skipped).
 *
 * The Claude Code hook command must be a quoted, forward-slash path to the
 * extensionless POSIX wrapper.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  toBashPath,
  buildClaudeHookCommand,
  buildPosixWrapper,
} from '../../../../scripts/install-helpers.mjs';
import { hookBinFilenames } from '../../../../scripts/uninstall-helpers.mjs';

const WIN_BASE = 'C:\\Users\\Fabio\\.local\\bin\\agenfk-mcp-enforcer';

describe('toBashPath', () => {
  it('turns backslashes into forward slashes', () => {
    expect(toBashPath('C:\\Users\\Fabio\\.local\\bin\\x')).toBe('C:/Users/Fabio/.local/bin/x');
  });
  it('leaves a POSIX path untouched', () => {
    expect(toBashPath('/home/u/.local/bin/x')).toBe('/home/u/.local/bin/x');
  });
});

describe('buildClaudeHookCommand', () => {
  it('win32: quoted, forward-slash, extensionless, no backslash', () => {
    const cmd = buildClaudeHookCommand(WIN_BASE, { platform: 'win32' });
    expect(cmd).toBe('"C:/Users/Fabio/.local/bin/agenfk-mcp-enforcer"');
    expect(cmd).not.toContain('\\');
    expect(cmd).not.toContain('.cmd');
  });
  it('win32: args go outside the quotes', () => {
    expect(buildClaudeHookCommand(WIN_BASE, { platform: 'win32', args: '--client claude-code' }))
      .toBe('"C:/Users/Fabio/.local/bin/agenfk-mcp-enforcer" --client claude-code');
  });
  it('win32: a path with spaces stays one quoted token', () => {
    expect(buildClaudeHookCommand('C:\\Users\\A B\\.local\\bin\\agenfk-pr-hook', { platform: 'win32' }))
      .toBe('"C:/Users/A B/.local/bin/agenfk-pr-hook"');
  });
  it('non-win32: unchanged from the plain path', () => {
    expect(buildClaudeHookCommand('/home/u/.local/bin/agenfk-pr-hook', { platform: 'linux', args: '--client claude-code' }))
      .toBe('/home/u/.local/bin/agenfk-pr-hook --client claude-code');
  });
});

describe('buildPosixWrapper', () => {
  it('embeds the .mjs path with forward slashes only', () => {
    const w = buildPosixWrapper('C:\\repo\\bin\\agenfk-run-hook.mjs');
    expect(w).toBe('#!/bin/sh\nexec node "C:/repo/bin/agenfk-run-hook.mjs" "$@"\n');
    expect(w).not.toContain('\\');
  });
});

describe('the generated command actually resolves under bash', () => {
  const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  const hasBash = bash.status === 0;

  it.skipIf(!hasBash)('runs a wrapper whose dir contains a space', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agenfk hook '));
    try {
      const wrapper = path.join(dir, 'agenfk-fake-hook');
      writeFileSync(wrapper, '#!/bin/sh\necho "hook-ran $*"\n', 'utf8');
      chmodSync(wrapper, 0o755);
      const cmd = buildClaudeHookCommand(wrapper, { platform: 'win32', args: '--client claude-code' });
      const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
      expect(r.stdout.trim()).toBe('hook-ran --client claude-code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('uninstall still removes what the installer now writes on win32', () => {
  it('lists both the .cmd shim and the extensionless wrapper', () => {
    const names = hookBinFilenames('win32');
    expect(names).toContain('agenfk-mcp-enforcer.cmd');
    expect(names).toContain('agenfk-mcp-enforcer');
    expect(names).toContain('agenfk-pr-hook');
  });
  it('linux unchanged', () => {
    expect(hookBinFilenames('linux')).toEqual(['agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook']);
  });
});
