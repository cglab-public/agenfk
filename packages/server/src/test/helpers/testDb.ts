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
