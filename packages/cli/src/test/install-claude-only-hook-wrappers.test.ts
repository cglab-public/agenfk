/**
 * GitHub #192, the targeted install: `agenfk integration install <client>` and
 * `agenfk integration resume <client>` run install.mjs with --only=<client>.
 * That run registers the client's hooks, pointing at wrappers in ~/.local/bin -
 * but the step that writes those wrappers ran only on a whole install. So a
 * machine whose wrappers came from an older installer (or none at all) was left
 * with hooks that answer "No such file or directory" (exit 127) on every tool
 * call; Claude Code treats that as non-blocking, so the guards silently vanished.
 *
 * Contract: after a single-client install into an empty HOME, every agenfk hook
 * it registered names a file that exists, and Claude's hooks run under the hook
 * shell. Named install-*.test.ts, so the windows-compat job runs it on
 * windows-latest as well as the normal Linux run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runInstall, cleanupHome, makeHome, type RunResult } from './helpers/runInstaller';
import { hookShell } from './helpers/hookShell';
import { claudeHookCommands } from '../../../../scripts/install-helpers.mjs';
import { HOOK_VARIANTS } from '../../../../scripts/uninstall-helpers.mjs';

const isWin = process.platform === 'win32';
const WIN_ENV = isWin
  ? { ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
  : {};

const homes: string[] = [];
afterAll(() => { for (const h of homes) cleanupHome(h); });

describe('GitHub #192 - a Claude-only install leaves every hook it registers runnable', () => {
  let home = '';
  let r: RunResult;
  const registered: Record<string, string> = {};

  beforeAll(() => {
    // A space in the home: off Windows it makes the installer single-quote the command.
    home = makeHome('agenfk claude-only');
    homes.push(home);
    r = runInstall(['--only=claude', '--rules-scope=global'], home, undefined, WIN_ENV);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const groups of Object.values<any[]>(settings.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        const name = String(h.command).match(/(agenfk-[a-z-]+)/)?.[1];
        if (name) registered[name] = h.command;
      }
    }
  }, 180_000);

  it('completes and registers every agenfk hook with the command the installer derives for it', () => {
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(registered).toEqual(claudeHookCommands(path.join(home, '.local', 'bin')));
  });

  it('writes the wrapper each registered hook runs', () => {
    for (const name of HOOK_VARIANTS) {
      expect(fs.existsSync(path.join(home, '.local', 'bin', name)), name).toBe(true);
    }
  });

  it('each hook is found and started by the hook shell (no exit 127)', () => {
    const shell = hookShell();
    for (const [name, command] of Object.entries(registered)) {
      const res = spawnSync(shell, ['-c', command], {
        input: '{}',
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        env: {
          ...process.env,
          HOME: home, USERPROFILE: home,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
          // Keeps the gatekeeper and enforcer off any real server (port 9 refuses at once).
          AGENFK_API_URL: 'http://127.0.0.1:9',
        },
      });
      expect(res.error, name).toBeUndefined(); // a hang killed by the timeout must not pass
      expect(res.status, `${name}: ${res.stderr}`).not.toBe(127);
      expect(res.stderr, name).not.toMatch(/No such file or directory|command not found/);
    }
  });
});

/** Codex, Gemini and Cursor register agenfk-pr-hook in their own config, when the client's dir exists. */
describe.each([
  ['codex', ['.codex', 'hooks.json']],
  ['gemini', ['.gemini', 'settings.json']],
  ['cursor', ['.cursor', 'hooks.json']],
] as const)('GitHub #192 - a %s-only install writes the pr-hook it registers', (client, configPath) => {
  let home = '';
  let r: RunResult;

  beforeAll(() => {
    home = makeHome(`agenfk ${client}-only`);
    homes.push(home);
    fs.mkdirSync(path.join(home, configPath[0]), { recursive: true });
    r = runInstall([`--only=${client}`, '--rules-scope=global'], home, undefined, WIN_ENV);
  }, 180_000);

  it('registers agenfk-pr-hook and writes the file it points at', () => {
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const config = fs.readFileSync(path.join(home, ...configPath), 'utf8');
    expect(config).toContain('agenfk-pr-hook');
    const prHook = path.join(home, '.local', 'bin', isWin ? 'agenfk-pr-hook.cmd' : 'agenfk-pr-hook');
    expect(fs.existsSync(prHook), prHook).toBe(true);
  });
});
