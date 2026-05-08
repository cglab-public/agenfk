/**
 * `agenfk restart --quiet` (and the auto-restart-after-fleet-upgrade path)
 * must NOT open a browser window. When the local API process is restarted
 * by a fleet upgrade directive, the user shouldn't get a surprise tab — the
 * dashboard was already open in their browser before the upgrade started.
 *
 * Source-introspection tests, mirroring the install-script.test.ts approach.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/index.ts'), 'utf8');
const START_SERVICES = fs.readFileSync(path.join(REPO_ROOT, 'scripts/start-services.mjs'), 'utf8');
const INSTALL_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'scripts/install.mjs'), 'utf8');

describe('agenfk restart --quiet', () => {
  it('declares the --quiet flag on the restart command', () => {
    const restartIdx = CLI_SRC.search(/\.command\(['"]restart['"]\)/);
    expect(restartIdx).toBeGreaterThan(-1);
    // .option('--quiet'…) must appear before the next .action(
    const actionIdx = CLI_SRC.indexOf('.action', restartIdx);
    const section = CLI_SRC.slice(restartIdx, actionIdx);
    expect(section).toMatch(/\.option\(\s*['"]-?-?q?,?\s*--quiet/);
  });

  it('declares the --quiet flag on the up command (so restart can pass it through)', () => {
    const upIdx = CLI_SRC.search(/\.command\(['"]up['"]\)/);
    expect(upIdx).toBeGreaterThan(-1);
    const actionIdx = CLI_SRC.indexOf('.action', upIdx);
    const section = CLI_SRC.slice(upIdx, actionIdx);
    expect(section).toMatch(/\.option\(\s*['"]-?-?q?,?\s*--quiet/);
  });

  it('start-services.mjs gates the browser-open block on AGENFK_NO_OPEN_BROWSER', () => {
    // The legacy script unconditionally opens the dashboard. After the fix,
    // a truthy AGENFK_NO_OPEN_BROWSER env var must skip the open call so a
    // fleet-triggered restart doesn't surface a new tab.
    expect(START_SERVICES).toMatch(/AGENFK_NO_OPEN_BROWSER/);
    const openCmdIdx = START_SERVICES.indexOf("xdg-open");
    expect(openCmdIdx).toBeGreaterThan(-1);
    const gateIdx = START_SERVICES.search(/AGENFK_NO_OPEN_BROWSER/);
    expect(gateIdx).toBeLessThan(openCmdIdx);
  });

  it('install.mjs passes --quiet when auto-restarting after a fleet upgrade', () => {
    // The post-install restart block (BUG 174270e6) spawns `agenfk restart`.
    // After this fix, it must include --quiet so the auto-launched browser
    // window does not appear during a fleet-driven upgrade.
    // Match the exact "agenfk.js'), 'restart'" spawn args list. The CLI
    // bin path appears in many other contexts in install.mjs; we want the
    // one feeding `restart` to the spawn.
    const restartCallIdx = INSTALL_SCRIPT.search(/agenfk\.js['"][^\n]*['"]restart['"]/);
    expect(restartCallIdx).toBeGreaterThan(-1);
    // Look at the immediate ~200 chars after the spawn args for --quiet.
    const window = INSTALL_SCRIPT.slice(restartCallIdx, restartCallIdx + 200);
    expect(window).toMatch(/--quiet/);
  });
});
