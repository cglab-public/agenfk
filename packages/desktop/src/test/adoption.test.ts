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
import {
  adoptVerdict, judgeServer, makeJudge, sameDatabase, statWithin, versionMismatchNotice,
  CLI_INSTALL_URL, STAT_DEADLINE_MS,
} from '../main/adoption.js';

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
  it('adopts a server of the same version', async () => {
    expect(await adoptVerdict({ version: '2.0.0-beta.46', dbPath: WIN_DB }, windowsApp, nothing))
      .toEqual({ kind: 'adopt' });
  });

  it('adopts a server of the same version even on another database', async () => {
    // Same build, same UI: nothing stale to show. Not this bug's business.
    expect(await adoptVerdict({ version: '2.0.0-beta.46', dbPath: WSL_DB }, windowsApp, nothing))
      .toEqual({ kind: 'adopt' });
  });

  it('skips a server of another version on another database (the WSL case)', async () => {
    expect(await adoptVerdict({ version: '2.0.0-beta.35', dbPath: WSL_DB }, windowsApp, nothing))
      .toEqual({ kind: 'skip', serverVersion: '2.0.0-beta.35' });
  });

  it('adopts and flags a server of another version on the app database', async () => {
    // A second server here would race the first for the same SQLite file.
    expect(await adoptVerdict({ version: '2.0.0-beta.35', dbPath: MAC_DB }, macApp, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'same' });
  });

  it('adopts and flags when the server database is unknown', async () => {
    // Not knowing is not proof of a different file. The safe side is the one
    // that cannot put two servers on one database.
    expect(await adoptVerdict({ version: '2.0.0-beta.35', dbPath: null }, windowsApp, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'unknown' });
  });

  it('reads a legacy .json path as the .sqlite file the server really opens', async () => {
    // The server remaps .json to .sqlite and reports the remapped path; the
    // app still holds the configured .json. Same file, one server.
    const legacy = { ...macApp, dbPath: MAC_DB.replace(/\.sqlite$/, '.json') };
    expect(await adoptVerdict({ version: '2.0.0-beta.35', dbPath: MAC_DB }, legacy, nothing))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'same' });
  });

  it('adopts with the notice when stat on the server path does not answer', async () => {
    const hung = () => 'no-answer' as const;
    expect(await adoptVerdict({ version: '2.0.0-beta.35', dbPath: 'D:\\agenfk\\db.sqlite' }, windowsApp, hung))
      .toEqual({ kind: 'adopt-mismatch', serverVersion: '2.0.0-beta.35', database: 'unknown' });
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

  it('opens the CLI install guide when the notice asks for it', () => {
    const shown = source.slice(source.indexOf('versionMismatchNotice({'));
    expect(shown).toMatch(/buttons:\s*notice\.buttons/);
    expect(shown).toMatch(/notice\.actions\[response\]\s*===\s*'open-cli-install'\)\s*openExternally\(CLI_INSTALL_URL\)/);
  });
});

describe('sameDatabase', () => {
  it('ignores case and separators on Windows', async () => {
    expect(await sameDatabase(WIN_DB, 'c:/users/eduardojosepin/.agenfk-system/.agenfk/db.sqlite', 'win32', nothing))
      .toBe('same');
  });

  it('ignores case on macOS, whose default volume is case-insensitive', async () => {
    expect(await sameDatabase(MAC_DB, MAC_DB.toLowerCase(), 'darwin', nothing)).toBe('same');
  });

  it('resolves dot segments before comparing', async () => {
    expect(await sameDatabase(MAC_DB, '/Users/eduardo/.agenfk-system/x/../.agenfk/db.sqlite', 'darwin', nothing))
      .toBe('same');
  });

  it('tells a Linux path from a Windows path on Windows', async () => {
    expect(await sameDatabase(WSL_DB, WIN_DB, 'win32', files({ [WIN_DB]: 'win' }))).toBe('different');
  });

  it('is case-sensitive on Linux', async () => {
    const other = WSL_DB.replace('eduardopin', 'EduardoPin');
    expect(await sameDatabase(other, WSL_DB, 'linux', files({ [WSL_DB]: 'a', [other]: 'b' }))).toBe('different');
  });

  it('matches identical paths', async () => {
    expect(await sameDatabase(WSL_DB, WSL_DB, 'linux', nothing)).toBe('same');
  });

  it('matches two paths that reach the same file, such as through a symlink', async () => {
    // Saying "another database" here would start a second server on one file.
    const viaLink = '/data/agenfk/db.sqlite';
    expect(await sameDatabase(viaLink, WSL_DB, 'linux', files({ [WSL_DB]: 'f1', [viaLink]: 'f1' }))).toBe('same');
  });

  it('is different for a server path this machine cannot reach', async () => {
    expect(await sameDatabase('/srv/other/db.sqlite', WSL_DB, 'linux', files({ [WSL_DB]: 'f1' }))).toBe('different');
  });

  it('reads a WSL /mnt/<drive> path as the Windows drive it mounts', async () => {
    // A WSL server on a database under /mnt/c holds the Windows app's file.
    const viaDrvfs = '/mnt/c/Users/EduardoJosePin/.agenfk-system/.agenfk/db.sqlite';
    expect(await sameDatabase(viaDrvfs, WIN_DB, 'win32', nothing)).toBe('same');
  });

  it('reads a \\\\wsl.localhost share as the Linux path behind it', async () => {
    const share = '\\\\wsl.localhost\\Ubuntu\\home\\eduardopin\\.agenfk-system\\.agenfk\\db.sqlite';
    expect(await sameDatabase(WSL_DB, share, 'win32', nothing)).toBe('same');
  });

  it('reads a \\\\wsl$ share as the Linux path behind it', async () => {
    const share = '\\\\wsl$\\Ubuntu\\home\\eduardopin\\.agenfk-system\\.agenfk\\db.sqlite';
    expect(await sameDatabase(WSL_DB, share, 'win32', nothing)).toBe('same');
  });

  it('reads a Windows drive path as its /mnt mount when the app is Linux in WSL', async () => {
    // The mirror of the /mnt case: a Linux build inside WSL, next to a Windows
    // server reporting the same file by its drive letter.
    const viaDrvfs = '/mnt/c/Users/EduardoJosePin/.agenfk-system/.agenfk/db.sqlite';
    expect(await sameDatabase(WIN_DB, viaDrvfs, 'linux', nothing)).toBe('same');
  });

  it('never touches a network or device path the server reported', async () => {
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
      expect(await sameDatabase(reported, WIN_DB, 'win32', spy)).toBe('different');
      expect(touched).not.toContain(reported);
      expect(touched.filter(p => /^[\\/]{2}/.test(p))).toEqual([]);
    }
  });

  it('still compares the files behind a local drive path on Windows', async () => {
    const viaJunction = 'D:\\agenfk\\db.sqlite';
    expect(await sameDatabase(viaJunction, WIN_DB, 'win32', files({ [viaJunction]: 'f1', [WIN_DB]: 'f1' })))
      .toBe('same');
  });

  it('still tells a WSL home from a Windows drive', async () => {
    expect(await sameDatabase(WSL_DB, WIN_DB, 'win32', nothing)).toBe('different');
  });

  it('tells one Linux path in two WSL distros apart', async () => {
    const ubuntu = '\\\\wsl.localhost\\Ubuntu\\home\\x\\db.sqlite';
    const debian = '\\\\wsl.localhost\\Debian\\home\\x\\db.sqlite';
    expect(await sameDatabase(ubuntu, debian, 'win32', nothing)).toBe('different');
    expect(await sameDatabase('\\\\wsl$\\Ubuntu\\home\\x\\db.sqlite', ubuntu, 'win32', nothing)).toBe('same');
  });

  it('is unknown, not different, when stat does not answer in time', async () => {
    // Reading a timeout as "another file" would start a second server on one
    // SQLite file.
    const hung = () => 'no-answer' as const;
    expect(await sameDatabase('D:\\agenfk\\db.sqlite', WIN_DB, 'win32', hung)).toBe('unknown');
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

  it('offers the CLI install guide, for a user who has no agenfk command', () => {
    // A desktop-only install may have no CLI on PATH, so `agenfk down` alone
    // leaves the user without a way out.
    const open = notice.actions.indexOf('open-cli-install');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(notice.buttons[open]).toMatch(/install/i);
    expect(notice.buttons).toHaveLength(notice.actions.length);
    expect(notice.actions[notice.defaultId]).toBe('dismiss');
    expect(CLI_INSTALL_URL).toMatch(/^https:\/\/github\.com\/cglab-public\/agenfk#installation/);
  });
});

describe('statWithin', () => {
  it('names the file stat found', async () => {
    const fileId = statWithin(async () => ({ dev: 7, ino: 42 }), 50);
    expect(await fileId('/x')).toEqual({ id: '7:42' });
  });

  it('is null when stat fails, as for a path that reaches no file', async () => {
    const fileId = statWithin(async () => { throw new Error('ENOENT'); }, 50);
    expect(await fileId('/x')).toBeNull();
  });

  it('gives up on a stat that does not return in time', async () => {
    // A mapped drive or an offline OneDrive folder can hold stat for tens of
    // seconds, and boot() waits on this before it opens a window.
    const fileId = statWithin(() => new Promise(() => {}), 20);
    const started = Date.now();
    expect(await fileId('/x')).toBe('no-answer');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits no longer than an unanswered HTTP probe', () => {
    expect(STAT_DEADLINE_MS).toBeLessThanOrEqual(2000);
  });
});
