/**
 * Removes the run's HOME sandbox (scripts/vitest-home-pin.mjs) when the run ends.
 *
 * Nothing used to: every run left an `agenfk-test-home-*` directory in the
 * tmpdir, and once the server suite's sqlite databases moved into it (card
 * c89e677d) each one carried ~50 MB of -wal/-shm sidecars.
 *
 * The sandbox is read from the project's own resolved env - the value its
 * workers were given - not from process.env, so a vitest launched inside a
 * test can never inherit and delete its parent's sandbox. vitest runs every
 * project's teardown only after the whole run has finished, so one project
 * cannot pull the sandbox from under another; the second teardown finds
 * nothing, which is fine.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testHomePrefix } from './vitest-home-pin.mjs';

// .native: on Windows it also expands 8.3 names, so the long-form sandbox matches an 8.3 TEMP (#208).
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// Both names vitest-home-pin gives a sandbox: plain, and the accented one the
// Windows CI job runs under (AGENFK_TEST_UNICODE_HOME, #201/#208).
const PREFIXES = [testHomePrefix({}), testHomePrefix({ AGENFK_TEST_UNICODE_HOME: '1' })];

/** A sandbox is a directory named like one, directly under the tmpdir - nothing else is deleted. */
function isSandbox(home) {
  if (typeof home !== 'string' || !home) return false;
  const abs = path.resolve(home);
  const name = path.basename(abs);
  return PREFIXES.some(p => name.startsWith(p))
    && real(path.dirname(abs)) === real(os.tmpdir());
}

export default function setup(project) {
  const home = project?.config?.env?.HOME;
  return () => {
    if (isSandbox(home)) fs.rmSync(home, { recursive: true, force: true });
  };
}
