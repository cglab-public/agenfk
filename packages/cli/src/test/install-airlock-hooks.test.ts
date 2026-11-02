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
});
