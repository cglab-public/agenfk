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

export function adoptVerdict(
  found: ServerIdentity,
  app: AppIdentity,
  fileId: FileId = realFileId,
): AdoptVerdict {
  if (found.version === app.version) return { kind: 'adopt' };
  const serverVersion = found.version;
  // Unknown is not proof of a different file; adopting is the side that
  // cannot put two servers on one database.
  if (found.dbPath === null) return { kind: 'adopt-mismatch', serverVersion, database: 'unknown' };
  if (sameDatabase(found.dbPath, app.dbPath, app.platform, fileId)) {
    return { kind: 'adopt-mismatch', serverVersion, database: 'same' };
  }
  return { kind: 'skip', serverVersion };
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

/** Identifies a file on this machine, or null when the path does not reach one. */
export type FileId = (p: string) => { id: string } | null;

const realFileId: FileId = p => {
  try {
    const s = fs.statSync(p);
    return { id: `${s.dev}:${s.ino}` };
  } catch {
    return null;
  }
};

/**
 * The file a configured path really names, spelled so two spellings of one
 * file compare equal.
 *
 * The server opens `x.sqlite` when configured with a legacy `x.json` and
 * reports the remapped path. On Windows, WSL spells a drive as `/mnt/c/...`
 * and Windows spells a WSL file as `\\wsl.localhost\<distro>\...` (or
 * `\\wsl$\...`): both are mapped to the other side's spelling.
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
  const share = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+(?=[\\/])/i.exec(out);
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
export function sameDatabase(
  serverPath: string,
  appPath: string,
  platform: NodeJS.Platform,
  fileId: FileId = realFileId,
): boolean {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p: string) => {
    const n = pathApi.normalize(canonical(p, platform));
    return caseInsensitive ? n.toLowerCase() : n;
  };
  if (norm(serverPath) === norm(appPath)) return true;

  const server = fileId(canonical(serverPath, platform));
  const app = fileId(canonical(appPath, platform));
  return !!server && !!app && server.id === app.id;
}

export interface Notice {
  title: string;
  detail: string;
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
      `To use the app's own version, run \`agenfk down\` in a terminal and reopen AgEnFK Desktop.`,
  };
}
