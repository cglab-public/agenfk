/**
 * The Airlock report token (GH-294, TEL-1): the credential the unsandboxed
 * launcher sends, as x-agenfk-airlock-report, with the sandbox proxy's
 * decisions (POST /airlock/proxy-decisions).
 *
 * Its own file, not verify-token: the sandboxed agent must keep reading
 * verify-token (agenfk verify, review record and the hub banner use it), while
 * this one lives in ~/.agenfk/airlock/, a 0700 directory the sandbox spec
 * denies reads of as a whole (temporary files included). Neither token stands
 * in for the other.
 *
 * At startup the server checks the token through an opened descriptor: a
 * regular file, one link (a hard-link alias elsewhere would be a copy the
 * sandbox might read), 0600 or tighter, 64 hex characters. Anything else, or
 * no file, and a fresh token is written by temp file + rename, which leaves any
 * old alias holding a dead value. Stray temp files are removed.
 *
 * The route reads the file per request (it is 65 bytes; no cache, so nothing
 * stale can be accepted), so it always accepts what launchers read now: two
 * servers recovering at once cannot leave one accepting a token nobody holds.
 *
 * Every read opens with O_NOFOLLOW | O_NONBLOCK and checks the descriptor is a
 * regular file before reading: a FIFO planted at the path cannot hang the
 * server, and a symlink is not followed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const AIRLOCK_REPORT_HEADER = 'x-agenfk-airlock-report';
const TOKEN = /^[0-9a-f]{64}$/;
const TOKEN_FILE = 'report-token';
const TEMP = /^\.report-token\.\d+\.[0-9a-f]+\.tmp$/;
/** A temp file older than this is a leftover, not another server's write in progress. */
const STRAY_TEMP_MS = 60_000;

export const airlockReportDir = (home: string = os.homedir()): string => path.join(home, '.agenfk', 'airlock');
export const airlockReportTokenPath = (home: string = os.homedir()): string => path.join(airlockReportDir(home), TOKEN_FILE);

/**
 * Is this stat of the token file safe to trust? On Windows the mode bits are
 * not POSIX permissions (a file reads 0o666 or 0o444 whatever its ACL), so that
 * one condition is skipped there: the user profile's ACL is what keeps
 * ~/.agenfk private. Everything else holds on every platform.
 */
export const safeTokenStat = (
  st: Pick<fs.Stats, 'isFile' | 'nlink' | 'mode' | 'size'>,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  st.isFile() && st.nlink === 1 && (platform === 'win32' || (st.mode & 0o077) === 0) && st.size > 0 && st.size <= 128;

/** O_NOFOLLOW and O_NONBLOCK where the platform has them (Windows has neither: 0). */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The token in `file`, read through one descriptor that is checked first; null when missing or unsafe. */
export function readSafeAirlockReportToken(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    if (!safeTokenStat(fs.fstatSync(fd))) return null;
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const token = buf.subarray(0, n).toString('utf8').trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function removeStrayTemps(dir: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!TEMP.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.lstatSync(p).mtimeMs >= STRAY_TEMP_MS) fs.unlinkSync(p);
    } catch { /* gone already */ }
  }
}

/**
 * At startup: the token in `file` when it is safe, else a fresh one written in
 * its place. Throws only when it can neither read nor write one.
 */
export function ensureAirlockReportToken(file: string = airlockReportTokenPath(), now: number = Date.now()): string {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  removeStrayTemps(dir, now);
  const existing = readSafeAirlockReportToken(file);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  // In the denied directory, so never readable from the sandbox even for an instant.
  const tmp = path.join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // rename replaces the name only: a hard-link alias keeps the old, now dead, value.
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never made, or renamed */ }
    throw e;
  }
  return token;
}

/**
 * The route's view of the token: the file as it is now, read and checked on
 * every call through one descriptor. Null (refuse) when it is missing or unsafe.
 */
export function airlockReportTokenReader(file: string = airlockReportTokenPath()): () => string | null {
  return () => readSafeAirlockReportToken(file);
}
