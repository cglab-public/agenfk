import * as fs from 'fs';
import * as path from 'path';

/**
 * Where a server test keeps its sqlite database (card c89e677d).
 *
 * The directory is pinned per run by scripts/vitest-home-pin.mjs, inside the
 * HOME sandbox, so the database, its -wal/-shm sidecars and whatever the
 * server writes beside it never land in the repository - not even when a run
 * is interrupted before its teardown.
 */
export function testDbPath(name: string): string {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`testDbPath takes a file name, got ${JSON.stringify(name)}`);
  }
  const dir = process.env.AGENFK_TEST_DB_DIR;
  if (!dir) {
    throw new Error('AGENFK_TEST_DB_DIR is not set: run the suite through vitest, whose config pins it (scripts/vitest-home-pin.mjs)');
  }
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * Delete a test database and its -wal/-shm sidecars (GitHub #208).
 *
 * `close` runs first - the server's `closeStorage`, or a spec's own provider's
 * `shutdown` - because Windows refuses to delete a file that is still open
 * (EBUSY), which POSIX allows. The retries cover the moment the OS takes to
 * let go of a handle that was just closed.
 */
export async function removeTestDb(dbPath: string, close?: () => Promise<unknown>): Promise<void> {
  await close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}
