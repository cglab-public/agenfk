import * as fs from 'fs';

export interface TempDirDeps {
  platform: NodeJS.Platform;
  rm: (dir: string) => void;
  warn: (message: string) => void;
}

const defaults: TempDirDeps = {
  platform: process.platform,
  rm: (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  warn: (message) => console.warn(message),
};

/**
 * Remove a spec's temp directory in teardown (GitHub #208).
 *
 * On Windows a running process keeps its working directory open, and a
 * directory that is open cannot be removed (EBUSY/EPERM). The server goes on
 * after a route answers - recording a hub event runs `git remote get-url` in
 * the project's root, and git.exe is a wrapper whose real git outlives a
 * timeout kill - so a teardown can find the repo of a test that already passed
 * still in use. After the retries, that EBUSY leaves the directory behind with
 * a warning instead of failing a file whose tests all passed. Anything else
 * still throws - EPERM too, which is also a read-only file or a deny ACE a
 * spec forgot to restore - and so does every error off Windows.
 */
export function removeTempDir(dir: string, deps: TempDirDeps = defaults): void {
  try {
    deps.rm(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (deps.platform === 'win32' && code === 'EBUSY') {
      deps.warn(`[test teardown] left ${dir}: a background process still has it open (${code})`);
      return;
    }
    throw e;
  }
}
