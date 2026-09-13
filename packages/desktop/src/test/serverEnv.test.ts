/**
 * CGLAB-167 blocking finding 1: which database does the desktop app open?
 *
 * The server falls back to `findProjectRoot(process.cwd())` when nothing tells
 * it otherwise. A GUI app has no meaningful cwd — launched from Finder it is
 * "/", so that fallback resolves to /.agenfk/db.sqlite and the child dies on
 * EPERM before it can serve a byte. The desktop process must therefore decide
 * the path itself, using the same chain `scripts/start-services.mjs` uses, so
 * the app and the terminal always see the same board.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveDbPath } from '../main/serverEnv.js';

const HOME = '/home/dev';
const CONFIG = path.join(HOME, '.agenfk', 'config.json');

/** Stub filesystem: only the listed files exist, with the given contents. */
const files = (entries: Record<string, string>) => ({
  exists: (p: string) => Object.prototype.hasOwnProperty.call(entries, p),
  read: (p: string) => entries[p],
});

describe('resolveDbPath', () => {
  it('prefers an explicit AGENFK_DB_PATH over everything else', () => {
    const chosen = resolveDbPath({
      env: { AGENFK_DB_PATH: '/explicit/db.sqlite' },
      homedir: HOME,
      fs: files({ [CONFIG]: JSON.stringify({ dbPath: '/from/config.sqlite' }) }),
    });
    expect(chosen).toBe('/explicit/db.sqlite');
  });

  it('falls back to dbPath from ~/.agenfk/config.json — the same DB the CLI uses', () => {
    const chosen = resolveDbPath({
      env: {},
      homedir: HOME,
      fs: files({ [CONFIG]: JSON.stringify({ dbPath: '/home/dev/.agenfk-system/.agenfk/db.sqlite' }) }),
    });
    expect(chosen).toBe('/home/dev/.agenfk-system/.agenfk/db.sqlite');
  });

  it('never returns a path under the filesystem root when there is no config', () => {
    // The exact failure: cwd "/" would make the server choose /.agenfk/db.sqlite.
    const chosen = resolveDbPath({ env: {}, homedir: HOME, fs: files({}) });
    expect(chosen.startsWith(HOME)).toBe(true);
    expect(chosen).not.toBe('/.agenfk/db.sqlite');
  });

  it('always returns an absolute path, never one relative to the cwd', () => {
    for (const fsStub of [files({}), files({ [CONFIG]: '{}' })]) {
      expect(path.isAbsolute(resolveDbPath({ env: {}, homedir: HOME, fs: fsStub }))).toBe(true);
    }
  });

  it('survives a malformed config instead of taking the cwd fallback', () => {
    const chosen = resolveDbPath({
      env: {},
      homedir: HOME,
      fs: files({ [CONFIG]: '{ this is not json' }),
    });
    expect(chosen.startsWith(HOME)).toBe(true);
  });

  it('ignores a config that exists but has no dbPath', () => {
    const chosen = resolveDbPath({
      env: {},
      homedir: HOME,
      fs: files({ [CONFIG]: JSON.stringify({ telemetry: true }) }),
    });
    expect(chosen.startsWith(HOME)).toBe(true);
  });

  it('ignores an empty AGENFK_DB_PATH rather than resolving to ""', () => {
    const chosen = resolveDbPath({
      env: { AGENFK_DB_PATH: '' },
      homedir: HOME,
      fs: files({ [CONFIG]: JSON.stringify({ dbPath: '/from/config.sqlite' }) }),
    });
    expect(chosen).toBe('/from/config.sqlite');
  });
});
