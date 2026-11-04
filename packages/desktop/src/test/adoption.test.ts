/**
 * BUG cdae6039: an AgEnFK server of another version is on the port. Adopt it?
 *
 * Observed on Windows: a 2.0.0-beta.35 server started in WSL was forwarded to
 * localhost:3000, the desktop app adopted it, and the window showed that
 * server's old UI. Adopting must stay the rule whenever the server sits on the
 * app's own database (two servers on one SQLite file is the failure
 * serverLifecycle exists to prevent). A server on ANOTHER database is not the
 * app's to share, so a version mismatch there means: start our own.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { adoptVerdict, judgeServer, makeJudge, sameDatabase, versionMismatchNotice } from '../main/adoption.js';

const WIN_DB = 'C:\\Users\\EduardoJosePin\\.agenfk-system\\.agenfk\\db.sqlite';
const WSL_DB = '/home/eduardopin/.agenfk-system/.agenfk/db.sqlite';
const MAC_DB = '/Users/eduardo/.agenfk-system/.agenfk/db.sqlite';

const windowsApp = { version: '2.0.0-beta.46', dbPath: WIN_DB, platform: 'win32' as const };
const macApp = { version: '2.0.0-beta.46', dbPath: MAC_DB, platform: 'darwin' as const };

/** A filesystem where only the listed paths exist, each with a file id. */
const files = (ids: Record<string, string>) => (p: string) =>
  p in ids ? { id: ids[p] } : null;
// The real one would answer from whatever this machine holds; WSL_DB exists
// on the author's machine.
const nothing = files({});

describe('adoptVerdict', () => {
  it('adopts a server of the same version', () => {
    expect(adoptVerdict({ version: '2.0.0-beta.46', dbPath: WIN_DB }, windowsApp, nothing))
      .toEqual({ kind: 'adopt' });
  });

  it('adopts a server of the same version even on another database', () => {
    // Same build, same UI: nothing stale to show. Not this bug's business.
    expect(adoptVerdict({ version: '2.0.0-beta.46', dbPath: WSL_DB }, windowsApp, nothing))
      .toEqual({ kind: 'adopt' });
  });

  it('skips a server of another version on another database (the WSL case)', () => {
    expect(adoptVerdict({ version: '2.0.0-beta.35', dbPath: WSL_DB }, windowsApp, nothing))
      .toEqual({ kind: 'skip', serverVersion: '2.0.0-beta.35' });
  });

  it('adopts and flags a server of another version on the app database', () => {
    // A second server here would race the first for the same SQLite file.
    expect(adoptVerdict({ version: '2.0.0-beta.35', dbPath: MAC_DB }, macApp, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'same' });
  });

  it('adopts and flags when the server database is unknown', () => {
    // Not knowing is not proof of a different file. The safe side is the one
    // that cannot put two servers on one database.
    expect(adoptVerdict({ version: '2.0.0-beta.35', dbPath: null }, windowsApp, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'unknown' });
  });

  it('reads a legacy .json path as the .sqlite file the server really opens', () => {
    // The server remaps .json to .sqlite and reports the remapped path; the
    // app still holds the configured .json. Same file, one server.
    const legacy = { ...macApp, dbPath: MAC_DB.replace(/\.sqlite$/, '.json') };
    expect(adoptVerdict({ version: '2.0.0-beta.35', dbPath: MAC_DB }, legacy, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'same' });
  });
});

describe('judgeServer', () => {
  it('adopts when the identity read fails, since the probe already saw AgEnFK', async () => {
    // A blip is no evidence of another database; skipping could fork a
    // second server onto ours.
    expect(await judgeServer(3000, async () => null, windowsApp, nothing)).toEqual({ kind: 'adopt' });
  });

  it('judges the identity it read', async () => {
    const read = async () => ({ version: '2.0.0-beta.35', dbPath: WSL_DB });
    expect(await judgeServer(3000, read, windowsApp, nothing))
      .toEqual({ kind: 'skip', serverVersion: '2.0.0-beta.35' });
  });

  it('reads the identity of the port it was asked about', async () => {
    const asked: number[] = [];
    await judgeServer(3004, async port => { asked.push(port); return null; }, windowsApp, nothing);
    expect(asked).toEqual([3004]);
  });
});

describe('makeJudge', () => {
  const deps = (over: Partial<Parameters<typeof makeJudge>[0]> = {}) => ({
    appVersion: () => '2.0.0-beta.46',
    appDbPath: () => WIN_DB,
    platform: 'win32' as const,
    readIdentity: async () => ({ version: '2.0.0-beta.35', dbPath: WIN_DB }),
    fileId: nothing,
    ...over,
  });

  it('never skips a server that reports the app database', async () => {
    expect((await makeJudge(deps())(3000)).kind).toBe('adopt-mismatch');
  });

  it('skips a server of another version on another database', async () => {
    const judge = makeJudge(deps({ readIdentity: async () => ({ version: '2.0.0-beta.35', dbPath: WSL_DB }) }));
    expect(await judge(3000)).toEqual({ kind: 'skip', serverVersion: '2.0.0-beta.35' });
  });

  it('compares paths the way the app platform does', async () => {
    const otherCase = WIN_DB.toLowerCase();
    const read = async () => ({ version: '2.0.0-beta.35', dbPath: otherCase });
    expect((await makeJudge(deps({ readIdentity: read }))(3000)).kind).toBe('adopt-mismatch');
    expect((await makeJudge(deps({ readIdentity: read, platform: 'linux' }))(3000)).kind).toBe('skip');
  });

  it('reads the app version and database when it judges, not before', async () => {
    let version = '2.0.0-beta.35';
    const judge = makeJudge(deps({ appVersion: () => version }));
    expect((await judge(3000)).kind).toBe('adopt');
    version = '2.0.0-beta.46';
    expect((await judge(3000)).kind).toBe('adopt-mismatch');
  });

  it('asks about the port it is given', async () => {
    const asked: number[] = [];
    await makeJudge(deps({ readIdentity: async port => { asked.push(port); return null; } }))(3009);
    expect(asked).toEqual([3009]);
  });
});

describe('the desktop main process', () => {
  // index.ts boots Electron and cannot be imported here, so its wiring is
  // pinned by reading it, as platform.test.ts does: a judge written inline
  // there would be untested, and one that skips everything forks a second
  // server onto the app database.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../main/index.ts'), 'utf8');
  const call = source.slice(source.indexOf('resolveServer({'), source.indexOf('spawn: startServer'));

  it('judges found servers with makeJudge and the real identity read', () => {
    expect(call).toMatch(/judge:\s*makeJudge\(\{/);
    expect(call).toMatch(/readIdentity:\s*readServerIdentity/);
  });

  it('hands makeJudge the app version, its database and the running platform', () => {
    expect(call).toMatch(/appVersion:\s*\(\)\s*=>\s*app\.getVersion\(\)/);
    expect(call).toMatch(/appDbPath:\s*resolveDbPath/);
    expect(call).toMatch(/platform:\s*runningOn/);
  });
});

describe('sameDatabase', () => {
  it('ignores case and separators on Windows', () => {
    expect(sameDatabase(WIN_DB, 'c:/users/eduardojosepin/.agenfk-system/.agenfk/db.sqlite', 'win32', nothing))
      .toBe(true);
  });

  it('ignores case on macOS, whose default volume is case-insensitive', () => {
    expect(sameDatabase(MAC_DB, MAC_DB.toLowerCase(), 'darwin', nothing)).toBe(true);
  });

  it('resolves dot segments before comparing', () => {
    expect(sameDatabase(MAC_DB, '/Users/eduardo/.agenfk-system/x/../.agenfk/db.sqlite', 'darwin', nothing))
      .toBe(true);
  });

  it('tells a Linux path from a Windows path on Windows', () => {
    expect(sameDatabase(WSL_DB, WIN_DB, 'win32', files({ [WIN_DB]: 'win' }))).toBe(false);
  });

  it('is case-sensitive on Linux', () => {
    const other = WSL_DB.replace('eduardopin', 'EduardoPin');
    expect(sameDatabase(other, WSL_DB, 'linux', files({ [WSL_DB]: 'a', [other]: 'b' }))).toBe(false);
  });

  it('matches identical paths', () => {
    expect(sameDatabase(WSL_DB, WSL_DB, 'linux', nothing)).toBe(true);
  });

  it('matches two paths that reach the same file, such as through a symlink', () => {
    // Saying "another database" here would start a second server on one file.
    const viaLink = '/data/agenfk/db.sqlite';
    expect(sameDatabase(viaLink, WSL_DB, 'linux', files({ [WSL_DB]: 'f1', [viaLink]: 'f1' }))).toBe(true);
  });

  it('is false for a server path this machine cannot reach', () => {
    expect(sameDatabase('/srv/other/db.sqlite', WSL_DB, 'linux', files({ [WSL_DB]: 'f1' }))).toBe(false);
  });

  it('reads a WSL /mnt/<drive> path as the Windows drive it mounts', () => {
    // A WSL server on a database under /mnt/c holds the Windows app's file.
    const viaDrvfs = '/mnt/c/Users/EduardoJosePin/.agenfk-system/.agenfk/db.sqlite';
    expect(sameDatabase(viaDrvfs, WIN_DB, 'win32', nothing)).toBe(true);
  });

  it('reads a \\\\wsl.localhost share as the Linux path behind it', () => {
    const share = '\\\\wsl.localhost\\Ubuntu\\home\\eduardopin\\.agenfk-system\\.agenfk\\db.sqlite';
    expect(sameDatabase(WSL_DB, share, 'win32', nothing)).toBe(true);
  });

  it('reads a \\\\wsl$ share as the Linux path behind it', () => {
    const share = '\\\\wsl$\\Ubuntu\\home\\eduardopin\\.agenfk-system\\.agenfk\\db.sqlite';
    expect(sameDatabase(WSL_DB, share, 'win32', nothing)).toBe(true);
  });

  it('reads a Windows drive path as its /mnt mount when the app is Linux in WSL', () => {
    // The mirror of the /mnt case: a Linux build inside WSL, next to a Windows
    // server reporting the same file by its drive letter.
    const viaDrvfs = '/mnt/c/Users/EduardoJosePin/.agenfk-system/.agenfk/db.sqlite';
    expect(sameDatabase(WIN_DB, viaDrvfs, 'linux', nothing)).toBe(true);
  });

  it('never touches a network or device path the server reported', () => {
    // The path comes from whatever answers on loopback. On Windows, stat on
    // \\host\share opens an SMB session and can hand the user's NTLM hash to
    // that host.
    for (const reported of [
      '\\\\attacker\\share\\db.sqlite',
      '//attacker/share/db.sqlite',
      '\\\\?\\UNC\\attacker\\share\\db.sqlite',
      '\\\\.\\pipe\\x',
      '\\\\?\\C:\\Users\\x\\db.sqlite',
    ]) {
      const touched: string[] = [];
      const spy = (p: string) => { touched.push(p); return null; };
      expect(sameDatabase(reported, WIN_DB, 'win32', spy)).toBe(false);
      expect(touched).not.toContain(reported);
      expect(touched.filter(p => /^[\\/]{2}/.test(p))).toEqual([]);
    }
  });

  it('still compares the files behind a local drive path on Windows', () => {
    const viaJunction = 'D:\\agenfk\\db.sqlite';
    expect(sameDatabase(viaJunction, WIN_DB, 'win32', files({ [viaJunction]: 'f1', [WIN_DB]: 'f1' })))
      .toBe(true);
  });

  it('still tells a WSL home from a Windows drive', () => {
    expect(sameDatabase(WSL_DB, WIN_DB, 'win32', nothing)).toBe(false);
  });
});

describe('versionMismatchNotice', () => {
  const notice = versionMismatchNotice({
    serverVersion: '2.0.0-beta.35', appVersion: '2.0.0-beta.46', database: 'same',
  });

  it('says the database is shared only when that is known', () => {
    expect(notice.detail).toContain("this app's database");
    const unknown = versionMismatchNotice({
      serverVersion: '2.0.0-beta.35', appVersion: '2.0.0-beta.46', database: 'unknown',
    });
    expect(unknown.detail).not.toContain("on this app's database");
    expect(unknown.detail).toContain('could not tell');
  });

  it('names both versions', () => {
    expect(notice.detail).toContain('2.0.0-beta.35');
    expect(notice.detail).toContain('2.0.0-beta.46');
  });

  it('tells the user how to switch to the app version', () => {
    expect(notice.detail).toContain('agenfk down');
  });

  it('has a title', () => {
    expect(notice.title.length).toBeGreaterThan(0);
  });
});
