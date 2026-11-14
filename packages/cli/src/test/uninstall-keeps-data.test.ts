/**
 * Issue #214 — `uninstall` deleted the user's data while the README said it
 * was kept.
 *
 * Two directories held it, and both were removed whole:
 *   - ~/.agenfk: the database (when config.json points there), backup/,
 *     hub.json (hub enrolment), installation-id, config.json;
 *   - ~/.agenfk-system: on a default npx install the board database lives at
 *     ~/.agenfk-system/.agenfk/db.sqlite (install.mjs sets dbPath there).
 *
 * The contract now: a default uninstall removes the framework and the runtime
 * files, and keeps the data. `--purge-data` is the explicit way to delete it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from 'fs';
import path from 'path';
import { makeHome, cleanupHome, runUninstall } from './helpers/runInstaller';

describe('issue #214 — uninstall keeps user data by default', () => {
  let home: string;

  // Everything an installed, used AgEnFK leaves in the two directories. The
  // split below is the contract: STATE survives a default uninstall, RUNTIME
  // and the framework do not.
  const STATE_IN_HOME = [
    'db.sqlite',
    'db.sqlite-wal',
    'config.json',
    'hub.json',
    'installation-id',
    'hub-deadletter.jsonl',
    'jira-token.json',
    'backup/db-2026-10-20.sqlite',
  ];
  const RUNTIME_IN_HOME = [
    'verify-token',
    'server-port',
    'active-work.json',
    'active-work/session-1.json',
    'claude-runs.json',
    'upgrade-tier-cache.json',
    'bin/agenfk-gatekeeper.mjs',
  ];
  const SYSTEM_DB = ['.agenfk', 'db.sqlite'];

  const write = (segs: string[], body = 'x') => {
    mkdirSync(path.join(home, ...segs.slice(0, -1)), { recursive: true });
    writeFileSync(path.join(home, ...segs), body);
  };
  const exists = (...segs: string[]) => existsSync(path.join(home, ...segs));

  beforeEach(() => {
    home = makeHome('agenfk-uninstall-214');
    for (const rel of [...STATE_IN_HOME, ...RUNTIME_IN_HOME]) write(['.agenfk', ...rel.split('/')]);
    write(['.agenfk-system', ...SYSTEM_DB], 'boards');
    write(['.agenfk-system', 'scripts', 'install.mjs']);
    write(['.agenfk-system', 'package.json'], '{}');
    write(['.agenfk-system', 'packages', 'cli', 'dist', 'index.js']);
  });
  afterEach(() => cleanupHome(home));

  it('keeps every state file in ~/.agenfk on a default uninstall', () => {
    const r = runUninstall(['-y'], home);
    expect(r.status).toBe(0);
    for (const rel of STATE_IN_HOME) {
      expect(exists('.agenfk', ...rel.split('/')), `${rel} must survive`).toBe(true);
    }
  });

  it('removes the runtime files in ~/.agenfk on a default uninstall', () => {
    runUninstall(['-y'], home);
    for (const rel of RUNTIME_IN_HOME) {
      expect(exists('.agenfk', ...rel.split('/')), `${rel} must be removed`).toBe(false);
    }
  });

  it('keeps the board database under ~/.agenfk-system but removes the framework files', () => {
    runUninstall(['-y'], home);
    expect(exists('.agenfk-system', ...SYSTEM_DB)).toBe(true);
    expect(exists('.agenfk-system', 'scripts')).toBe(false);
    expect(exists('.agenfk-system', 'packages')).toBe(false);
    expect(exists('.agenfk-system', 'package.json')).toBe(false);
  });

  it('removes ~/.agenfk-system entirely when it holds no database directory', () => {
    // Nothing to keep there, so nothing (not even an empty dir) is left behind.
    cleanupHome(path.join(home, '.agenfk-system', '.agenfk'));
    runUninstall(['-y'], home);
    expect(exists('.agenfk-system')).toBe(false);
  });

  it('--purge-data deletes both directories, data included', () => {
    const r = runUninstall(['-y', '--purge-data'], home);
    expect(r.status).toBe(0);
    expect(exists('.agenfk')).toBe(false);
    expect(exists('.agenfk-system')).toBe(false);
  });

  it('says what it keeps, and how to delete it, before asking', () => {
    const r = runUninstall(['-y'], home);
    expect(r.stdout).toMatch(/kept/i);
    expect(r.stdout).toContain('--purge-data');
    // The old prompt called the home dir "config + verify token", which hid
    // the database, backups and hub enrolment it was about to delete.
    expect(r.stdout).not.toMatch(/~\/\.agenfk \(config \+ verify token\)/);
  });

  it('removes the gatekeeper bypass flag and the run hook\'s temp files, which are runtime too', () => {
    // skip-gatekeeper switches enforcement off for five minutes; left behind,
    // an uninstall + quick reinstall would come back with enforcement off.
    write(['.agenfk', 'skip-gatekeeper']);
    write(['.agenfk', 'claude-runs.json.4242']);
    runUninstall(['-y'], home);
    expect(exists('.agenfk', 'skip-gatekeeper')).toBe(false);
    expect(exists('.agenfk', 'claude-runs.json.4242')).toBe(false);
    expect(exists('.agenfk', 'hub.json')).toBe(true);
  });

  it('keeps a configured database that lives elsewhere under ~/.agenfk-system', () => {
    write(['.agenfk-system', 'data', 'board.sqlite'], 'boards');
    write(['.agenfk', 'config.json'], JSON.stringify({ dbPath: path.join(home, '.agenfk-system', 'data', 'board.sqlite') }));
    runUninstall(['-y'], home);
    expect(exists('.agenfk-system', 'data', 'board.sqlite')).toBe(true);
    expect(exists('.agenfk-system', 'scripts')).toBe(false);
  });

  it('keeps the target of a symlinked database directory', () => {
    cleanupHome(path.join(home, '.agenfk-system', '.agenfk'));
    write(['.agenfk-system', 'real-db', 'db.sqlite'], 'boards');
    symlinkSync(path.join(home, '.agenfk-system', 'real-db'), path.join(home, '.agenfk-system', '.agenfk'), 'junction');
    runUninstall(['-y'], home);
    expect(exists('.agenfk-system', 'real-db', 'db.sqlite')).toBe(true);
  });

  it('never deletes through a symlinked ~/.agenfk-system: with no data behind it, only the link goes', () => {
    // A developer pointing ~/.agenfk-system at their own checkout must not
    // lose the checkout. Removing the whole directory used to drop only the
    // link; enumerating it to keep the database must not change that.
    const checkout = path.join(home, 'checkout');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, 'precious-source.ts'), 'src');
    cleanupHome(path.join(home, '.agenfk-system'));
    symlinkSync(checkout, path.join(home, '.agenfk-system'), 'junction');
    const r = runUninstall(['-y'], home);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(checkout, 'precious-source.ts'))).toBe(true);
    expect(exists('.agenfk-system')).toBe(false);
  });

  it('keeps a symlinked ~/.agenfk-system when the board database is reached through it', () => {
    // Unlinking would leave config.json's dbPath dangling: the next install
    // creates a fresh directory there and opens an empty board instead.
    const checkout = path.join(home, 'checkout');
    mkdirSync(path.join(checkout, '.agenfk'), { recursive: true });
    writeFileSync(path.join(checkout, '.agenfk', 'db.sqlite'), 'boards');
    writeFileSync(path.join(checkout, 'precious-source.ts'), 'src');
    cleanupHome(path.join(home, '.agenfk-system'));
    symlinkSync(checkout, path.join(home, '.agenfk-system'), 'junction');
    const r = runUninstall(['-y'], home);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(checkout, 'precious-source.ts'))).toBe(true);
    expect(exists('.agenfk-system', '.agenfk', 'db.sqlite')).toBe(true);
  });

  it('keeps the SQLite sidecars of a database stored at the top of ~/.agenfk-system', () => {
    // WAL mode: the -wal file holds committed transactions not yet checkpointed.
    for (const f of ['board.sqlite', 'board.sqlite-wal', 'board.sqlite-shm']) write(['.agenfk-system', f]);
    write(['.agenfk', 'config.json'], JSON.stringify({ dbPath: path.join(home, '.agenfk-system', 'board.sqlite') }));
    runUninstall(['-y'], home);
    for (const f of ['board.sqlite', 'board.sqlite-wal', 'board.sqlite-shm']) {
      expect(exists('.agenfk-system', f), `${f} must survive`).toBe(true);
    }
    expect(exists('.agenfk-system', 'scripts')).toBe(false);
  });

  it('--purge-data warns that the data goes too', () => {
    const r = runUninstall(['-y', '--purge-data'], home);
    expect(r.stdout).toMatch(/database/i);
    expect(r.stdout).toMatch(/backup/i);
    expect(r.stdout).toMatch(/hub enrol/i);
  });
});
