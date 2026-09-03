#!/usr/bin/env node
/**
 * Stryker HOME guard (item 9c297075).
 *
 * Why: Stryker's vitest runner forces pool 'threads' (its CLI overrides the
 * user config), and on this machine (Node >= 24) the runner's child processes
 * keep a FROZEN C-level environment — process.env mutations inside the
 * process do not reach libuv, so os.homedir() keeps returning the machine
 * home even though process.env.HOME is the pinned sandbox. A test that writes
 * through a homedir-derived path would then land in the REAL home (this is
 * exactly how ~/.agenfk/server-port got deleted during a 2026-09-02 dry run,
 * and how the 2026-08-31 hub.json clobber class works).
 *
 * Fix: pin HOME at SPAWN time. The sandbox is baked into the C environ of
 * every process this wrapper spawns, so os.homedir() is sandboxed in every
 * test thread — no libuv linkage needed. AGENFK_SPAWN_PIN marks the run so
 * tests (home-isolation.test.ts) fail loudly when the linkage is frozen but
 * the run was NOT launched through this guard.
 *
 * The run is additionally wrapped with the home-integrity sentinel: any
 * drift in the real ~/.agenfk after the run is a hard failure, even if some
 * path bypassed the pin.
 *
 * Usage:
 *   npm run test:stryker -- run stryker.config.mjs [--reporters json,html]
 *   node scripts/stryker-home-wrap.mjs --probe   # test hook: child env JSON
 */
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { snapshotHome, verifyHome } from './home-integrity.mjs';
import { testEnv } from './vitest-home-pin.mjs';

const args = process.argv.slice(2);
const probe = args[0] === '--probe';

// Sentinel: snapshot the real home BEFORE (os.homedir() = this process's
// C-level home — the one the spawned children inherit).
const snapshot = snapshotHome();

const env = { ...process.env, ...testEnv(), AGENFK_SPAWN_PIN: '1' };

let result;
if (probe) {
  // Test hook: spawn a child and report what IT sees (the mechanism under
  // test — whether the spawned C environ actually carries the sandbox).
  result = spawnSync(
    process.execPath,
    [
      '-p',
      "JSON.stringify({ home: require('os').homedir(), spawnPin: process.env.AGENFK_SPAWN_PIN, realHome: process.env.AGENFK_REAL_HOME })",
    ],
    { encoding: 'utf8', env },
  );
} else {
  result = spawnSync('npx', ['stryker', ...args], { stdio: 'inherit', env });
}

const exitCode = result.status ?? 1;

if (probe) process.stdout.write(result.stdout ?? '');

const check = verifyHome(os.homedir(), snapshot);
if (!check.ok) {
  console.error('✗ HOME INTEGRITY DRIFT after Stryker run — the real ~/.agenfk was touched:');
  for (const f of check.drift) console.error(`   ${f}`);
  process.exit(exitCode === 0 ? 1 : exitCode);
}

process.exit(exitCode);
