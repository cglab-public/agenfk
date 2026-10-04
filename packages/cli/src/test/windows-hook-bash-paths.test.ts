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
  claudeHookCommands,
  applyClaudeHooks,
} from '../../../../scripts/install-helpers.mjs';
import { hookBinFilenames, HOOK_VARIANTS } from '../../../../scripts/uninstall-helpers.mjs';

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
  it('non-win32: a path holding a space or a quote is one single-quoted word (af174cdd)', () => {
    expect(buildClaudeHookCommand("/Users/A B/it's/.local/bin/agenfk-pr-hook", { platform: 'darwin', args: '--client claude-code' }))
      .toBe("'/Users/A B/it'\\''s/.local/bin/agenfk-pr-hook' --client claude-code");
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
    expect(hookBinFilenames('linux')).toEqual(['agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook', 'agenfk-run-hook']);
  });
});

// agenfk-run-hook (CGLAB-177) landed after the fix above and was registered as
// a bare `.cmd` path, so on Windows it failed exactly as #192 describes. Every
// hook the installer registers for Claude Code comes from one table now; a hook
// missing from it is a test failure, not a silent Windows regression.
describe('claudeHookCommands — every agenfk hook, one rule', () => {
  const WIN_BIN = 'C:\\Users\\Fabio\\.local\\bin';

  it('has a command for every hook variant, and nothing else', () => {
    expect(Object.keys(claudeHookCommands(WIN_BIN, { platform: 'win32' })).sort()).toEqual([...HOOK_VARIANTS].sort());
  });

  it('win32: every command is a quoted forward-slash path to the extensionless wrapper', () => {
    for (const [name, cmd] of Object.entries(claudeHookCommands(WIN_BIN, { platform: 'win32' }))) {
      expect(cmd, name).not.toContain('\\');
      expect(cmd, name).not.toMatch(/\.cmd\b/);
      expect(cmd.startsWith(`"C:/Users/Fabio/.local/bin/${name}"`), `${name}: ${cmd}`).toBe(true);
    }
  });

  it('the PR and run hooks tell the hook which client fired it', () => {
    const cmds = claudeHookCommands(WIN_BIN, { platform: 'win32' });
    expect(cmds['agenfk-pr-hook']).toBe('"C:/Users/Fabio/.local/bin/agenfk-pr-hook" --client claude-code');
    expect(cmds['agenfk-run-hook']).toBe('"C:/Users/Fabio/.local/bin/agenfk-run-hook" --client claude-code');
    expect(cmds['agenfk-gatekeeper']).toBe('"C:/Users/Fabio/.local/bin/agenfk-gatekeeper"');
  });

  it('non-win32: plain paths, as before', () => {
    expect(claudeHookCommands('/home/u/.local/bin', { platform: 'linux' })).toEqual({
      'agenfk-gatekeeper': '/home/u/.local/bin/agenfk-gatekeeper',
      'agenfk-mcp-enforcer': '/home/u/.local/bin/agenfk-mcp-enforcer',
      'agenfk-pr-hook': '/home/u/.local/bin/agenfk-pr-hook --client claude-code',
      'agenfk-run-hook': '/home/u/.local/bin/agenfk-run-hook --client claude-code',
    });
  });
});

// What the installer actually writes into ~/.claude/settings.json, as a pure
// function so the win32 shape is pinned on any OS (CI runs Linux, and on POSIX a
// hand-built command is the same string as the table's).
describe('applyClaudeHooks — the settings.json the installer writes', () => {
  const WIN_BIN = 'C:\\Users\\Fabio\\.local\\bin';
  const agenfkCommands = (settings: any): string[] =>
    Object.values(settings.hooks).flat().flatMap((e: any) => e.hooks ?? []).map((h: any) => h.command)
      .filter((c: string) => c.includes('agenfk-'));

  it('win32: every agenfk hook command is one Git Bash can run', () => {
    const cmds = agenfkCommands(applyClaudeHooks({}, WIN_BIN, { platform: 'win32' }));
    expect(cmds).toHaveLength(5);
    for (const c of cmds) {
      expect(c).toMatch(/^"C:\/Users\/Fabio\/\.local\/bin\/agenfk-[a-z-]+"( --client claude-code)?$/);
    }
  });

  it('registers the run hook on PostToolUse and SessionEnd, with the SessionEnd timeout', () => {
    const s = applyClaudeHooks({}, WIN_BIN, { platform: 'win32' });
    const run = '"C:/Users/Fabio/.local/bin/agenfk-run-hook" --client claude-code';
    expect(s.hooks.PostToolUse.flatMap((e: any) => e.hooks).map((h: any) => h.command)).toContain(run);
    expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: 'command', command: run, timeout: 10 });
  });

  it('an upgrade over the old .cmd registrations replaces them and keeps the user\'s own hooks', () => {
    const old = (name: string, args = '') => ({ hooks: [{ type: 'command', command: `${WIN_BIN}\\${name}.cmd${args}` }] });
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] };
    const before = {
      hooks: {
        PreToolUse: [old('agenfk-gatekeeper'), old('agenfk-mcp-enforcer'), mine],
        PostToolUse: [old('agenfk-pr-hook', ' --client claude-code'), old('agenfk-run-hook', ' --client claude-code')],
        SessionEnd: [old('agenfk-run-hook', ' --client claude-code')],
        Stop: [old('agenfk-run-hook', ' --client claude-code')],
      },
    };
    const after = applyClaudeHooks(before, WIN_BIN, { platform: 'win32' });
    const cmds = agenfkCommands(after);
    expect(cmds).toHaveLength(5);
    expect(cmds.some(c => c.includes('.cmd'))).toBe(false);
    expect(after.hooks.PreToolUse).toContainEqual(mine);
    expect(after.hooks.Stop).toBeUndefined();
    // and running it again is a no-op
    expect(agenfkCommands(applyClaudeHooks(after, WIN_BIN, { platform: 'win32' }))).toEqual(cmds);
  });
});
