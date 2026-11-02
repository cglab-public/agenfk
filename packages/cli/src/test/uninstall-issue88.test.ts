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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  HOOK_VARIANTS,
  hookBinFilenames,
  opencodePluginFilenames,
  isAgenfkHookEntry,
  stripAgenfkHookEntries,
  resolveConfirmation,
  summarizeResults,
  topLevelEntryWithin,
  isAgenfkCliWrapper,
} from '../../../../scripts/uninstall-helpers.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const UNINSTALL = path.join(ROOT, 'scripts', 'uninstall.mjs');

// ---------------------------------------------------------------------------
// Part A — pure helpers
// ---------------------------------------------------------------------------
describe('issue #88 — uninstall-helpers', () => {
  it('tracks every hook variant, not just the gatekeeper (Bug 2)', () => {
    // agenfk-run-hook joined the set in CGLAB-177. It matters here for the
    // reason this test exists: a hook the uninstaller does not know about is
    // left armed on disk, firing into a framework that is no longer there.
    expect(HOOK_VARIANTS).toEqual(
      expect.arrayContaining([
        'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook', 'agenfk-run-hook',
      ])
    );
    expect(HOOK_VARIANTS).toHaveLength(4);
  });

  it('hookBinFilenames includes the CLI symlink + every hook, with .cmd on win32', () => {
    expect(hookBinFilenames('linux')).toEqual([
      'agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook', 'agenfk-run-hook',
    ]);
    expect(hookBinFilenames('win32')).toEqual([
      'agenfk.cmd', 'agenfk-gatekeeper.cmd', 'agenfk-mcp-enforcer.cmd',
      'agenfk-pr-hook.cmd', 'agenfk-run-hook.cmd',
      // #192: the extensionless sh wrappers Claude Code's Git Bash hooks run,
      // and (#215) the CLI's own, which install.mjs writes under MinGW too
      'agenfk', 'agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook', 'agenfk-run-hook',
    ]);
  });

  it('opencodePluginFilenames covers exactly the plugins that exist on disk (Bug 3)', () => {
    // Asserting a hardcoded list here is what let the previous version claim a
    // plugin the installer never writes. The installer copies
    // `bin/<name>-opencode.mjs` and nothing else, so that directory is the
    // authority — read it. Adding a plugin without listing it (or listing one
    // that does not exist) fails here instead of leaking a file on uninstall.
    const binDir = path.resolve(fileURLToPath(import.meta.url), '../../../../../bin');
    const onDisk = readdirSync(binDir)
      .filter(f => f.endsWith('-opencode.mjs'))
      .map(f => f.replace('-opencode.mjs', '.mjs'))
      .sort();
    expect(opencodePluginFilenames().slice().sort()).toEqual(onDisk);
  });

  it('removes every bin the installer writes, so none is left armed', () => {
    // The real invariant, and the reason HOOK_VARIANTS gained a fourth entry:
    // a hook binary the uninstaller does not know about stays on disk and keeps
    // firing into a framework that is gone. Opencode plugins are deliberately
    // NOT tied to this count — not every hook has one.
    expect(hookBinFilenames('linux')).toEqual(['agenfk', ...HOOK_VARIANTS]);
    // On win32 each is also an extensionless sh wrapper: Claude Code runs hooks
    // through Git Bash, which cannot execute a .cmd (#192), and Git Bash runs
    // the CLI's own wrapper as `agenfk` (#215).
    expect(hookBinFilenames('win32')).toEqual([
      ...['agenfk', ...HOOK_VARIANTS].map(n => `${n}.cmd`),
      'agenfk',
      ...HOOK_VARIANTS,
    ]);
    expect(HOOK_VARIANTS).toContain('agenfk-run-hook');
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
describe('#215 — isAgenfkCliWrapper', () => {
  it('recognises the Git Bash wrapper install.mjs writes', () => {
    expect(isAgenfkCliWrapper('#!/bin/sh\nnode "C:/Users/u/.agenfk-system/packages/cli/bin/agenfk.js" "$@"')).toBe(true);
    expect(isAgenfkCliWrapper('#!/bin/sh\r\nnode "C:\\Users\\u\\.agenfk-system\\packages\\cli\\bin\\agenfk.js" "$@"\r\n')).toBe(true);
  });
  it('leaves anything else alone', () => {
    expect(isAgenfkCliWrapper('#!/bin/sh\nexec /opt/my-own-agenfk "$@"')).toBe(false);
    expect(isAgenfkCliWrapper('')).toBe(false);
  });
});

describe('#214 — topLevelEntryWithin', () => {
  it('treats a name that merely starts with ".." as inside the root', () => {
    expect(topLevelEntryWithin('/r', '/r/..boards/db.sqlite', path.posix)).toBe('..boards');
  });
  it('rejects the parent, a sibling and the root itself', () => {
    expect(topLevelEntryWithin('/r', '/db.sqlite', path.posix)).toBeNull();
    expect(topLevelEntryWithin('/r', '/r2/db.sqlite', path.posix)).toBeNull();
    expect(topLevelEntryWithin('/r', '/r', path.posix)).toBeNull();
  });
});

describe('issue #88 — uninstall.mjs removes every installed artifact', () => {
  let home: string;

  const p = (...segs: string[]) => path.join(home, ...segs);
  const hookEntry = (cmd: string) => ({ matcher: 'X', hooks: [{ type: 'command', command: cmd }] });
  const UNRELATED = { matcher: 'X', hooks: [{ type: 'command', command: '/usr/bin/user-hook' }] };

  function seedInstall() {
    // bins
    mkdirSync(p('.local', 'bin'), { recursive: true });
    for (const f of ['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook']) {
      writeFileSync(p('.local', 'bin', f), '#!/bin/sh\n');
    }
    // The CLI wrapper as install.mjs writes it. On win32 the uninstaller removes
    // the extensionless `agenfk` only when it is this wrapper (#215).
    writeFileSync(p('.local', 'bin', 'agenfk'), `#!/bin/sh\nnode "${p('.agenfk-system', 'packages', 'cli', 'bin', 'agenfk.js')}" "$@"`);
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
    // codex hooks.json — new installs write the valid nested schema (CGLAB-12)
    mkdirSync(p('.codex'), { recursive: true });
    writeFileSync(p('.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/h/agenfk-pr-hook --client codex' }] }, UNRELATED],
      },
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
    // Gemini command TOMLs leaked by an older install — BOTH layouts, plus the
    // macOS AppleDouble twin. Uninstall must clear all three shapes.
    mkdirSync(p('.gemini', 'commands', 'agenfk'), { recursive: true });
    writeFileSync(p('.gemini', 'commands', 'agenfk-release.toml'), 'leaked flat\n');
    writeFileSync(p('.gemini', 'commands', '._agenfk-release-beta.toml'), 'leaked twin\n');
    writeFileSync(p('.gemini', 'commands', 'agenfk', 'release.toml'), 'leaked nested\n');
    // The AppleDouble twin of the nested agenfk/ dir — no extension, so it needs
    // the artifact clause rather than the .toml suffix test to be removed.
    writeFileSync(p('.gemini', 'commands', '._agenfk'), 'twin of the nested dir\n');
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
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('removes leaked Gemini command TOMLs in both layouts, including the AppleDouble twin', () => {
    runUninstall(['-y']);
    expect(existsSync(p('.gemini', 'commands', 'agenfk-release.toml'))).toBe(false);
    expect(existsSync(p('.gemini', 'commands', '._agenfk-release-beta.toml'))).toBe(false);
    expect(existsSync(p('.gemini', 'commands', 'agenfk'))).toBe(false);
    expect(existsSync(p('.gemini', 'commands', '._agenfk'))).toBe(false);
  });

  it('strips gatekeeper + mcp-enforcer (Pre) and pr-hook (Post) from claude settings, keeping unrelated (Bug 2)', () => {
    runUninstall(['-y']);
    const s = readJson('.claude', 'settings.json');
    expect(JSON.stringify(s.hooks.PreToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.PostToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain('user-hook');
    expect(JSON.stringify(s.hooks.PostToolUse)).toContain('user-hook');
  });

  // Behaviour behind run-hook-close.test.ts's scan of uninstall.mjs (GH-281): the
  // run hook lives on SessionEnd (and, on older installs, Stop). Left behind, it
  // runs a deleted binary at the end of every Claude Code session.
  it('strips the run hook from SessionEnd and from a leftover Stop, keeping unrelated entries', () => {
    const s0 = readJson('.claude', 'settings.json');
    s0.hooks.SessionEnd = [{ hooks: [{ type: 'command', command: '/h/agenfk-run-hook --client claude-code', timeout: 10 }] }, UNRELATED];
    s0.hooks.Stop = [{ hooks: [{ type: 'command', command: '/h/agenfk-run-hook --client claude-code' }] }, UNRELATED];
    writeFileSync(p('.claude', 'settings.json'), JSON.stringify(s0, null, 2));
    expect(runUninstall(['-y']).status).toBe(0);
    const s = readJson('.claude', 'settings.json');
    expect(JSON.stringify(s.hooks.SessionEnd ?? [])).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.Stop ?? [])).not.toContain('agenfk-');
    expect(JSON.stringify(s.hooks.SessionEnd)).toContain('user-hook');
    expect(JSON.stringify(s.hooks.Stop)).toContain('user-hook');
  });

  it('strips pr-hook from codex hooks.json, gemini AfterTool, and cursor afterShellExecution (Bug 3)', () => {
    runUninstall(['-y']);
    const codex = readJson('.codex', 'hooks.json');
    expect(JSON.stringify(codex.hooks.PostToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(codex.hooks.PostToolUse)).toContain('user-hook');

    const gemini = readJson('.gemini', 'settings.json');
    expect(JSON.stringify(gemini.hooks.AfterTool)).not.toContain('agenfk-');
    expect(JSON.stringify(gemini.hooks.AfterTool)).toContain('user-hook');

    const cursor = readJson('.cursor', 'hooks.json');
    expect(JSON.stringify(cursor.afterShellExecution)).not.toContain('agenfk-');
    expect(JSON.stringify(cursor.afterShellExecution)).toContain('user-hook');
  });

  it('strips pr-hook from a legacy top-level codex PostToolUse key (CGLAB-12 migration)', () => {
    // A pre-CGLAB-12 install wrote the invalid top-level shape. Uninstall must
    // still remove the agenfk entry from it (whichever schema is on disk).
    writeFileSync(p('.codex', 'hooks.json'), JSON.stringify({
      PostToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: '/h/agenfk-pr-hook --client codex' }] }, UNRELATED],
    }, null, 2));
    runUninstall(['-y']);
    const codex = readJson('.codex', 'hooks.json');
    expect(JSON.stringify(codex.PostToolUse)).not.toContain('agenfk-');
    expect(JSON.stringify(codex.PostToolUse)).toContain('user-hook');
  });

  it('removes the emptied legacy top-level PostToolUse key so Codex can start again (CGLAB-12)', () => {
    // The real affected population: our old installer was the only writer, so the
    // legacy file holds ONLY the agenfk entry. Stripping it must not leave
    // { PostToolUse: [] } behind — that empty top-level key still crashes Codex.
    writeFileSync(p('.codex', 'hooks.json'), JSON.stringify({
      PostToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: '/h/agenfk-pr-hook --client codex' }] }],
    }, null, 2));
    runUninstall(['-y']);
    const codex = readJson('.codex', 'hooks.json');
    expect(codex).not.toHaveProperty('PostToolUse');
  });

  it('--purge-data removes the entire ~/.agenfk data dir, not just verify-token (Bug 3)', () => {
    // #214: a default uninstall keeps the user's data; the whole-directory
    // removal Bug 3 asked for is now the explicit --purge-data path.
    runUninstall(['-y', '--purge-data']);
    expect(existsSync(p('.agenfk'))).toBe(false);
  });

  it('removes ~/.agenfk-system and reports success', () => {
    const r = runUninstall(['-y']);
    expect(existsSync(p('.agenfk-system'))).toBe(false);
    expect(r.status).toBe(0);
  });

  it.runIf(process.platform === 'win32')('removes the extensionless agenfk wrapper Git Bash runs, not only agenfk.cmd (#215)', () => {
    // install.mjs writes both under MinGW: agenfk.cmd for cmd/PowerShell and an
    // extensionless #!/bin/sh wrapper for Git Bash. Leaving the wrapper behind
    // kept `agenfk` on PATH pointing at a framework that was gone.
    writeFileSync(p('.local', 'bin', 'agenfk.cmd'), '@echo off\r\n');
    writeFileSync(p('.local', 'bin', 'agenfk'), `#!/bin/sh\nnode "${p('.agenfk-system', 'packages', 'cli', 'bin', 'agenfk.js')}" "$@"`);
    runUninstall(['-y']);
    expect(existsSync(p('.local', 'bin', 'agenfk.cmd'))).toBe(false);
    expect(existsSync(p('.local', 'bin', 'agenfk'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('keeps a ~/.local/bin/agenfk that is not the wrapper it wrote (#215 review)', () => {
    writeFileSync(p('.local', 'bin', 'agenfk'), '#!/bin/sh\nexec /opt/my-own-agenfk "$@"\n');
    runUninstall(['-y']);
    expect(existsSync(p('.local', 'bin', 'agenfk'))).toBe(true);
  });

  it('aborts without -y on non-interactive stdin and leaves artifacts intact (Bug 5)', () => {
    const r = runUninstall([]); // no -y, spawned => stdin not a TTY
    expect(r.status).not.toBe(0);
    // nothing destructive should have happened
    expect(existsSync(p('.agenfk-system'))).toBe(true);
    expect(existsSync(p('.local', 'bin', 'agenfk-gatekeeper'))).toBe(true);
  });
});
