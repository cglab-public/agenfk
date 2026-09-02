/**
 * Stryker HOME guard (item 9c297075) — scripts/stryker-home-wrap.mjs.
 *
 * Stryker's vitest runner forces pool 'threads', and on this machine (Node
 * >= 24) the runner's child processes keep a frozen C-level environment:
 * process.env mutations inside the process do not reach libuv
 * (os.homedir()). The vitest config's HOME pin (JS-level) therefore cannot
 * sandbox os.homedir() under Stryker. The guard pins HOME at SPAWN time
 * (baked into every child's C environ) and wraps the run with the
 * home-integrity sentinel. The --probe hook is what makes the spawn-time
 * mechanism itself testable.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WRAPPER = new URL('../../../../scripts/stryker-home-wrap.mjs', import.meta.url).pathname;

function probe() {
  const r = spawnSync(process.execPath, [WRAPPER, '--probe'], { encoding: 'utf8' });
  expect(r.status, `wrapper probe failed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim());
}

describe('stryker-home-wrap (item 9c297075)', () => {
  it('bakes the sandbox HOME into the spawned process (libuv-visible os.homedir)', () => {
    const p = probe();
    expect(p.home).toBeTruthy();
    expect(p.home, 'child os.homedir() must be the wrapper sandbox')
      .toContain('agenfk-test-home-');
    expect(p.home).not.toBe(process.env.HOME);
    expect(fs.existsSync(path.join(p.home, '.agenfk')), 'sandbox is pre-seeded').toBe(true);
  });

  it('marks spawn-time-pinned runs so tests can distinguish them from JS-level pins', () => {
    const p = probe();
    expect(p.spawnPin).toBe('1');
  });

  it('preserves the pre-pin home as AGENFK_REAL_HOME (and it differs from the sandbox)', () => {
    const p = probe();
    expect(p.realHome).toBeTruthy();
    expect(p.realHome).not.toBe(p.home);
  });
});
