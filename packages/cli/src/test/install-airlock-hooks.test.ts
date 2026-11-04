/**
 * GH-294 T4: the installer ships the Airlock adapters. The shared
 * agenfk-airlock.mjs goes to ~/.agenfk/bin on every run (pi spawns it and the
 * OpenCode plugin imports it from there, so a targeted --only install needs it
 * too), and the OpenCode plugin goes to ~/.config/opencode/plugins.
 *
 * Runs the real installer into a throwaway HOME (helpers/runInstaller).
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runInstall, cleanupHome, makeHome, REPO_ROOT } from './helpers/runInstaller';

const homes: string[] = [];
afterAll(() => { for (const h of homes) cleanupHome(h); });

const source = (name: string) => fs.readFileSync(path.join(REPO_ROOT, 'bin', name), 'utf8');

describe('GH-294 T4 - the installer ships the Airlock adapters', () => {
  it('agenfk-airlock.mjs copied on --only=pi', () => {
    const home = makeHome('agenfk-airlock-pi');
    homes.push(home);
    const r = runInstall(['--only=pi'], home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const installed = path.join(home, '.agenfk', 'bin', 'agenfk-airlock.mjs');
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.readFileSync(installed, 'utf8')).toBe(source('agenfk-airlock.mjs'));
    // It imports the port discovery from its sibling, which must be there too.
    expect(fs.existsSync(path.join(home, '.agenfk', 'bin', 'agenfk-gatekeeper.mjs'))).toBe(true);
  }, 180_000);

  it('opencode airlock plugin installed', () => {
    const home = makeHome('agenfk-airlock-opencode');
    homes.push(home);
    // OpenCode is "present" when its config dir exists.
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const r = runInstall(['--only=opencode'], home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const plugin = path.join(home, '.config', 'opencode', 'plugins', 'agenfk-airlock.mjs');
    expect(fs.existsSync(plugin)).toBe(true);
    expect(fs.readFileSync(plugin, 'utf8')).toBe(source('agenfk-airlock-opencode.mjs'));
    expect(fs.existsSync(path.join(home, '.agenfk', 'bin', 'agenfk-airlock.mjs'))).toBe(true);
  }, 180_000);

  // GH-356: Codex takes hooks only from hooks.json, so the Airlock hook is registered there, by a path
  // that is the same inside the machine. It does nothing outside the sandbox.
  it('codex: the Airlock hook is installed to ~/.agenfk/bin and registered as a PreToolUse hook', () => {
    const home = makeHome('agenfk-airlock-codex');
    homes.push(home);
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const r = runInstall(['--only=codex'], home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const script = path.join(home, '.agenfk', 'bin', 'agenfk-airlock-hook.mjs');
    expect(fs.readFileSync(script, 'utf8')).toBe(source('agenfk-airlock-hook.mjs'));
    const hooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command))).toContain(`node "${script}"`);
  }, 180_000);

  it('claude: its settings get no Airlock hook (the launcher gives it to a sandboxed claude)', () => {
    const home = makeHome('agenfk-airlock-claude');
    homes.push(home);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = runInstall(['--only=claude'], home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toContain('agenfk-airlock-hook');
    expect(fs.existsSync(path.join(home, '.agenfk', 'bin', 'agenfk-airlock-hook.mjs'))).toBe(true);
  }, 180_000);
});
