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

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** A sandbox is an `agenfk-test-home-*` directory directly under the tmpdir - nothing else is deleted. */
function isSandbox(home) {
  if (typeof home !== 'string' || !home) return false;
  const abs = path.resolve(home);
  return path.basename(abs).startsWith('agenfk-test-home-')
    && real(path.dirname(abs)) === real(os.tmpdir());
}

export default function setup(project) {
  const home = project?.config?.env?.HOME;
  return () => {
    if (isSandbox(home)) fs.rmSync(home, { recursive: true, force: true });
  };
}
