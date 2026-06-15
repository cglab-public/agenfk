/**
 * Tests for issue #88 — the uninstaller leaves artifacts behind.
 *
 * Part A: pure decision logic (scripts/uninstall-helpers.mjs).
 * Part B: end-to-end behavior — run scripts/uninstall.mjs against a throwaway
 *   $HOME populated with every artifact the installer creates, and assert the
 *   uninstaller removes ALL of them (all 3 hook variants, opencode plugins,
 *   codex/gemini/cursor hook entries, the ~/.agenfk dir) and exits 0.
 *
 * These reflect future functionality and are expected to fail until uninstall.mjs
 * is wired to the helpers and mirrors every install step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  HOOK_VARIANTS,
  hookBinFilenames,
  opencodePluginFilenames,
  isAgenfkHookEntry,
  stripAgenfkHookEntries,
  resolveConfirmation,
  summarizeResults,
} from '../../../../scripts/uninstall-helpers.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const UNINSTALL = path.join(ROOT, 'scripts', 'uninstall.mjs');

// ---------------------------------------------------------------------------
// Part A — pure helpers
// ---------------------------------------------------------------------------
describe('issue #88 — uninstall-helpers', () => {
  it('tracks all three hook variants, not just the gatekeeper (Bug 2)', () => {
    expect(HOOK_VARIANTS).toEqual(
      expect.arrayContaining(['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook'])
    );
    expect(HOOK_VARIANTS).toHaveLength(3);
  });

  it('hookBinFilenames includes the CLI symlink + all 3 hooks, with .cmd on win32', () => {
    expect(hookBinFilenames('linux')).toEqual([
      'agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook',
    ]);
    expect(hookBinFilenames('win32')).toEqual([
      'agenfk.cmd', 'agenfk-gatekeeper.cmd', 'agenfk-mcp-enforcer.cmd', 'agenfk-pr-hook.cmd',
    ]);
  });

  it('opencodePluginFilenames are the three .mjs plugins (Bug 3)', () => {
    expect(opencodePluginFilenames()).toEqual([
      'agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs', 'agenfk-pr-hook.mjs',
    ]);
  });

  it('isAgenfkHookEntry recognizes every variant and ignores unrelated entries', () => {
    expect(isAgenfkHookEntry({ hooks: [{ command: '/x/agenfk-gatekeeper' }] })).toBe(true);
    expect(isAgenfkHookEntry({ hooks: [{ command: '/x/agenfk-mcp-enforcer' }] })).toBe(true);
    expect(isAgenfkHookEntry({ command: '/x/agenfk-pr-hook --client codex' })).toBe(true);
    expect(isAgenfkHookEntry({ hooks: [{ command: '/x/some-other-tool' }] })).toBe(false);
  });

  it('stripAgenfkHookEntries removes all variants but preserves unrelated entries', () => {
    const entries = [
      { hooks: [{ command: '/b/agenfk-gatekeeper' }] },
      { hooks: [{ command: '/b/agenfk-mcp-enforcer' }] },
      { command: '/b/agenfk-pr-hook --client codex' },
      { hooks: [{ command: '/b/user-hook' }] },
    ];
    const out = stripAgenfkHookEntries(entries);
    expect(out).toEqual([{ hooks: [{ command: '/b/user-hook' }] }]);
  });

  it('resolveConfirmation: -y proceeds without prompting (Bug 5)', () => {
    expect(resolveConfirmation({ skipConfirm: true, isTTY: false })).toEqual({
      proceed: true, shouldPrompt: false,
    });
  });

  it('resolveConfirmation: interactive TTY prompts, does not auto-proceed (Bug 5)', () => {
    expect(resolveConfirmation({ skipConfirm: false, isTTY: true })).toEqual({
      proceed: false, shouldPrompt: true,
    });
  });

  it('resolveConfirmation: non-TTY without -y aborts instead of assuming yes (Bug 5)', () => {
    expect(resolveConfirmation({ skipConfirm: false, isTTY: false })).toEqual({
      proceed: false, shouldPrompt: false,
    });
  });

  it('summarizeResults aggregates counts and exits non-zero on any failure (Bug 4)', () => {
    const ok = summarizeResults([
      { label: 'a', status: 'removed' },
      { label: 'b', status: 'skipped' },
    ]);
    expect(ok).toMatchObject({ removed: 1, skipped: 1, failed: 0, exitCode: 0 });

    const bad = summarizeResults([
      { label: 'a', status: 'removed' },
      { label: 'c', status: 'failed', error: 'boom' },
    ]);
    expect(bad).toMatchObject({ removed: 1, failed: 1, exitCode: 1 });
    expect(bad.failures[0]).toMatchObject({ label: 'c', error: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// Part B — end-to-end uninstall against a throwaway HOME
// ---------------------------------------------------------------------------
describe('issue #88 — uninstall.mjs removes every installed artifact', () => {
  let home: string;

  const p = (...segs: string[]) => path.join(home, ...segs);
  const hookEntry = (cmd: string) => ({ matcher: 'X', hooks: [{ type: 'command', command: cmd }] });
  const UNRELATED = { matcher: 'X', hooks: [{ type: 'command', command: '/usr/bin/user-hook' }] };

  function seedInstall() {
    // bins
    mkdirSync(p('.local', 'bin'), { recursive: true });
    for (const f of ['agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook']) {
      writeFileSync(p('.local', 'bin', f), '#!/bin/sh\n');
    }
    // opencode plugins
    mkdirSync(p('.config', 'opencode', 'plugins'), { recursive: true });
    for (const f of ['agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs', 'agenfk-pr-hook.mjs']) {
      writeFileSync(p('.config', 'opencode', 'plugins', f), '// plugin\n');
    }
    // claude settings.json — Pre (gatekeeper + enforcer) and Post (pr-hook)
    mkdirSync(p('.claude'), { recursive: true });
    writeFileSync(p('.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [hookEntry('/h/agenfk-gatekeeper'), hookEntry('/h/agenfk-mcp-enforcer'), UNRELATED],
        PostToolUse: [hookEntry('/h/agenfk-pr-hook --client claude-code'), UNRELATED],
      },
    }, null, 2));
    // codex hooks.json
    mkdirSync(p('.codex'), { recursive: true });
    writeFileSync(p('.codex', 'hooks.json'), JSON.stringify({
      PostToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: '/h/agenfk-pr-hook --client codex' }] }, UNRELATED],
    }, null, 2));
    // gemini settings.json — AfterTool
    mkdirSync(p('.gemini'), { recursive: true });
    writeFileSync(p('.gemini', 'settings.json'), JSON.stringify({
      hooks: { AfterTool: [{ matcher: 'run_shell_command', command: '/h/agenfk-pr-hook --client gemini' }, { matcher: 'run_shell_command', command: '/usr/bin/user-hook' }] },
    }, null, 2));
    // cursor hooks.json — afterShellExecution
    mkdirSync(p('.cursor'), { recursive: true });
    writeFileSync(p('.cursor', 'hooks.json'), JSON.stringify({
      afterShellExecution: [{ command: '/h/agenfk-pr-hook --client cursor' }, { command: '/usr/bin/user-hook' }],
    }, null, 2));
    // ~/.agenfk data dir
    mkdirSync(p('.agenfk'), { recursive: true });
    writeFileSync(p('.agenfk', 'config.json'), JSON.stringify({ rulesScope: 'global' }));
    writeFileSync(p('.agenfk', 'verify-token'), 'tok');
    // framework dir
    mkdirSync(p('.agenfk-system', 'scripts'), { recursive: true });
    writeFileSync(p('.agenfk-system', 'marker'), 'x');
  }

  function runUninstall(args: string[]) {
    return spawnSync(process.execPath, [UNINSTALL, ...args], {
      encoding: 'utf8',
      // Empty PATH so the script can't find/spawn real claude/codex/gemini CLIs;
      // those steps self-skip. process.execPath is absolute so node still runs.
      env: { HOME: home, USERPROFILE: home, PATH: '' },
    });
  }

  const readJson = (...segs: string[]) => JSON.parse(readFileSync(p(...segs), 'utf8'));

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'agenfk-uninstall-'));
    seedInstall();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('removes all three hook bins and the agenfk CLI symlink (Bug 2)', () => {
    const r = runUninstall(['-y']);
    expect(r.status).toBe(0);
    for (const f of hookBinFilenames(os.platform())) {
      expect(existsSync(p('.local', 'bin', f))).toBe(false);
    }
  });

  it('removes all three opencode plugins (Bug 3)', () => {
    runUninstall(['-y']);
    for (const f of opencodePluginFilenames()) {
      expect(existsSync(p('.config', 'opencode', 'plugins', f))).toBe(false);
    }
  });

  it('strips gatekeeper + mcp-enforcer (Pre) and pr-hook (Post) from claude settings, keeping unrelated (Bug 2)', () => {
    runUninstall(['-y']);
    const s = readJson('.claude', 'settings.json');
    expect(JSON.stringify(s.hooks.PreToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.PostToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain('user-hook');
    expect(JSON.stringify(s.hooks.PostToolUse)).toContain('user-hook');
  });

  it('strips pr-hook from codex hooks.json, gemini AfterTool, and cursor afterShellExecution (Bug 3)', () => {
    runUninstall(['-y']);
    const codex = readJson('.codex', 'hooks.json');
    expect(JSON.stringify(codex.PostToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(codex.PostToolUse)).toContain('user-hook');

    const gemini = readJson('.gemini', 'settings.json');
    expect(JSON.stringify(gemini.hooks.AfterTool)).not.toContain('agenfk-');
    expect(JSON.stringify(gemini.hooks.AfterTool)).toContain('user-hook');

    const cursor = readJson('.cursor', 'hooks.json');
    expect(JSON.stringify(cursor.afterShellExecution)).not.toContain('agenfk-');
    expect(JSON.stringify(cursor.afterShellExecution)).toContain('user-hook');
  });

  it('removes the entire ~/.agenfk data dir, not just verify-token (Bug 3)', () => {
    runUninstall(['-y']);
    expect(existsSync(p('.agenfk'))).toBe(false);
  });

  it('removes ~/.agenfk-system and reports success', () => {
    const r = runUninstall(['-y']);
    expect(existsSync(p('.agenfk-system'))).toBe(false);
    expect(r.status).toBe(0);
  });

  it('aborts without -y on non-interactive stdin and leaves artifacts intact (Bug 5)', () => {
    const r = runUninstall([]); // no -y, spawned => stdin not a TTY
    expect(r.status).not.toBe(0);
    // nothing destructive should have happened
    expect(existsSync(p('.agenfk-system'))).toBe(true);
    expect(existsSync(p('.local', 'bin', 'agenfk-gatekeeper'))).toBe(true);
  });
});
