/**
 * BUG cdae6039 — an AgEnFK server is running. Is it ours to adopt?
 *
 * Adopting used to follow from identity alone. On Windows that adopted a WSL
 * server of an older version, forwarded to localhost, and the window showed
 * its stale UI. The version decides whether there is anything to worry about;
 * the database decides what we may do about it. Two servers on one SQLite
 * file is the failure serverLifecycle exists to prevent, so a server on the
 * app's own database is adopted whatever its version, and the user is told.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ServerIdentity } from './probes.js';

export type AdoptVerdict =
  | { kind: 'adopt' }
  /** Adopted although it is not our version: it holds, or may hold, our database. */
  | { kind: 'adopt-mismatch'; serverVersion: string; database: 'same' | 'unknown' }
  /** Another version on another database: start our own instead. */
  | { kind: 'skip'; serverVersion: string };

export interface AppIdentity {
  version: string;
  dbPath: string;
  platform: NodeJS.Platform;
}

export async function adoptVerdict(
  found: ServerIdentity,
  app: AppIdentity,
  fileId: FileId = realFileId,
): Promise<AdoptVerdict> {
  if (found.version === app.version) return { kind: 'adopt' };
  const serverVersion = found.version;
  // Unknown is not proof of a different file; adopting is the side that
  // cannot put two servers on one database.
  if (found.dbPath === null) return { kind: 'adopt-mismatch', serverVersion, database: 'unknown' };
  const database = await sameDatabase(found.dbPath, app.dbPath, app.platform, fileId);
  if (database === 'different') return { kind: 'skip', serverVersion };
  return { kind: 'adopt-mismatch', serverVersion, database };
}

/**
 * The verdict for the server on `port`, read fresh.
 *
 * The probe accepted it a moment before. A failed read now is a blip, not
 * evidence of another database, and skipping on it could fork a second
 * server onto ours.
 */
export async function judgeServer(
  port: number,
  readIdentity: (port: number) => Promise<ServerIdentity | null>,
  app: AppIdentity,
  fileId: FileId = realFileId,
): Promise<AdoptVerdict> {
  const found = await readIdentity(port);
  if (!found) return { kind: 'adopt' };
  return adoptVerdict(found, app, fileId);
}

export interface JudgeDeps {
  appVersion: () => string;
  appDbPath: () => string;
  platform: NodeJS.Platform;
  readIdentity: (port: number) => Promise<ServerIdentity | null>;
  fileId?: FileId;
}

/** The judge resolveServer is given, built here so it is tested, not inline in index.ts. */
export function makeJudge(deps: JudgeDeps): (port: number) => Promise<AdoptVerdict> {
  return port => judgeServer(
    port,
    deps.readIdentity,
    { version: deps.appVersion(), dbPath: deps.appDbPath(), platform: deps.platform },
    deps.fileId,
  );
}

/**
 * What stat said about a path: the file it names, null when the path reaches
 * no file, or 'no-answer' when stat did not return in time.
 */
export type FileAnswer = { id: string } | null | 'no-answer';

/** Identifies a file on this machine. */
export type FileId = (p: string) => FileAnswer | Promise<FileAnswer>;

/** The same wait httpGet in probes.ts gives a server that does not answer. */
export const STAT_DEADLINE_MS = 2000;

/**
 * A FileId that gives up after `ms`.
 *
 * boot() awaits the judge before it opens a window, and stat on a mapped
 * drive, an offline OneDrive folder or an autofs mount can hang for tens of
 * seconds. The stat left running is abandoned, not cancelled: Node has no way
 * to cancel one.
 */
export function statWithin(
  stat: (p: string) => Promise<{ dev: number | bigint; ino: number | bigint }>,
  ms: number,
): FileId {
  return p => new Promise<FileAnswer>(resolve => {
    const timer = setTimeout(() => resolve('no-answer'), ms);
    timer.unref?.();
    stat(p).then(
      s => { clearTimeout(timer); resolve({ id: `${s.dev}:${s.ino}` }); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

const realFileId: FileId = statWithin(p => fs.promises.stat(p), STAT_DEADLINE_MS);

/** The `\\wsl.localhost\<distro>\` or `\\wsl$\<distro>\` prefix of a path. */
const WSL_SHARE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?=[\\/])/i;

/**
 * The file a configured path really names, spelled so two spellings of one
 * file compare equal.
 *
 * The server opens `x.sqlite` when configured with a legacy `x.json` and
 * reports the remapped path. On Windows, WSL spells a drive as `/mnt/c/...`
 * and Windows spells a WSL file as `\\wsl.localhost\<distro>\...` (or
 * `\\wsl$\...`): both are mapped to the other side's spelling. The distro
 * is dropped here, so sameDatabase compares it on its own: two distros can
 * hold the same Linux path.
 */
function canonical(p: string, platform: NodeJS.Platform): string {
  let out = p.replace(/\.json$/, '.sqlite');
  if (platform !== 'win32') {
    // A Linux build inside WSL sees a Windows server's C:\ file under /mnt/c.
    const drive = /^([a-zA-Z]):[\\/]/.exec(out);
    if (platform === 'linux' && drive) {
      out = `/mnt/${drive[1].toLowerCase()}/${out.slice(drive[0].length).replace(/\\/g, '/')}`;
    }
    return out;
  }
  const drvfs = /^\/mnt\/([a-zA-Z])(?=\/|$)/.exec(out);
  if (drvfs) out = `${drvfs[1]}:${out.slice(drvfs[0].length) || '\\'}`;
  const share = WSL_SHARE.exec(out);
  if (share) out = out.slice(share[0].length);
  return out;
}

/**
 * Do the server's database path and the app's name the same file?
 *
 * Answering "different" by mistake starts a second server on one SQLite file,
 * so doubt leans to "same". Spellings are compared first, with the path
 * module of the app's platform: Windows and the default macOS volume ignore
 * case. Then the files themselves, so a symlink is not a second database. A
 * server path this machine cannot reach, such as a WSL home seen from
 * Windows, is not a file this app can open.
 */
export async function sameDatabase(
  serverPath: string,
  appPath: string,
  platform: NodeJS.Platform,
  fileId: FileId = realFileId,
): Promise<'same' | 'different' | 'unknown'> {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p: string) => {
    const n = pathApi.normalize(canonical(p, platform));
    return caseInsensitive ? n.toLowerCase() : n;
  };
  // Two shares naming different distros are two filesystems. A bare Linux
  // path names no distro, so it may be the share's: that case falls through.
  if (platform === 'win32') {
    const distro = (p: string) => WSL_SHARE.exec(p)?.[1].toLowerCase() ?? null;
    const [ds, da] = [distro(serverPath), distro(appPath)];
    if (ds && da && ds !== da) return 'different';
  }
  if (norm(serverPath) === norm(appPath)) return 'same';

  // The server path comes from whatever answers on loopback. Stat on a UNC or
  // device path opens a network session on Windows and can hand the user's
  // NTLM hash to that host, so only a local absolute path is looked at.
  const serverLocal = canonical(serverPath, platform);
  const local = platform === 'win32'
    ? /^[a-zA-Z]:[\\/]/.test(serverLocal)
    : serverLocal.startsWith('/');
  if (!local) return 'different';

  const [server, app] = await Promise.all([fileId(serverLocal), fileId(canonical(appPath, platform))]);
  // A stat that never returned is no proof of another file.
  if (server === 'no-answer' || app === 'no-answer') return 'unknown';
  return !!server && !!app && server.id === app.id ? 'same' : 'different';
}

/** The README section that installs the CLI and documents `agenfk down`. */
export const CLI_INSTALL_URL = 'https://github.com/cglab-public/agenfk#installation--setup';

export type NoticeAction = 'dismiss' | 'open-cli-install';

export interface Notice {
  title: string;
  detail: string;
  buttons: string[];
  /** What each button means, by position, so a reworded label cannot change what it does. */
  actions: NoticeAction[];
  defaultId: number;
}

export function versionMismatchNotice(v: {
  serverVersion: string;
  appVersion: string;
  database: 'same' | 'unknown';
}): Notice {
  const where = v.database === 'same'
    ? `is already running on this app's database`
    : `is already running, and the app could not tell whether it uses this app's database`;
  return {
    title: 'AgEnFK server version differs from this app',
    detail:
      `An AgEnFK server ${v.serverVersion} ${where}, ` +
      `so this window shows that server's interface, not the one from AgEnFK Desktop ${v.appVersion}.\n\n` +
      `To use the app's own version, run \`agenfk down\` in a terminal and reopen AgEnFK Desktop. ` +
      `If the agenfk command is not installed, the install guide sets it up.`,
    // Someone who installed only the desktop app may have no CLI on PATH (see
    // adoptFailureChoice), so the dialog offers the page that installs it.
    buttons: ['Continue', 'Open install guide'],
    actions: ['dismiss', 'open-cli-install'],
    defaultId: 0,
  };
}
