import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

let probed: boolean | undefined;
let privileged: boolean | undefined;

/**
 * Whether this process reads through a denial BY ITS ENVIRONMENT: root on
 * POSIX, or on Windows a token holding SeBackupPrivilege (an administrator,
 * as on GitHub's runner). Decided without calling makeUnreadable(), so the
 * spec that checks makeUnreadable() can skip on it and still catch a
 * regression in it. When whoami cannot answer, it says yes (skip, not a red
 * run that is the environment's fault).
 */
export function readsThroughDenials(): boolean {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  if (privileged !== undefined) return privileged;
  try {
    const whoami = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    privileged = /\bSeBackupPrivilege\b/.test(execFileSync(whoami, ['/priv'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true }));
  } catch {
    privileged = true;
  }
  return privileged;
}

/**
 * Whether makeUnreadable() actually stops THIS process listing a directory.
 *
 * root reads through chmod 000, and on Windows an administrator holding the
 * backup privilege (GitHub's windows-latest runner) reads through the deny ACE:
 * Node opens directories with backup semantics, which skip the access check.
 * Probed once by trying it, rather than guessed from the user, so the specs
 * that need an unreadable directory skip exactly where none can be made.
 */
export function canMakeUnreadable(): boolean {
  if (probed !== undefined) return probed;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-unreadable-probe-'));
  const dir = path.join(work, 'locked');
  fs.mkdirSync(dir);
  try {
    const restore = makeUnreadable(dir);
    try {
      fs.readdirSync(dir);
      probed = false;
    } catch {
      probed = true;
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return probed;
}

/**
 * Make `dir` unlistable; returns the function that undoes it (GitHub #208 phase 3).
 *
 * Off Windows that is `chmod 000`, as the specs always did. On Windows chmod
 * only sets a read-only attribute, which listing a directory ignores, so the
 * equivalent is an explicit deny ACE for listing (RD) granted to Everyone:
 * readdir then fails with EPERM, the way it fails with EACCES under chmod 000.
 * The owner keeps the right to change the ACL, so the deny can always be
 * removed again - call the returned function in a `finally`, or the directory
 * cannot be listed (or deleted) afterwards.
 */
export function makeUnreadable(dir: string): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o000);
    return () => fs.chmodSync(dir, 0o755);
  }
  const icacls = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const EVERYONE = '*S-1-1-0';
  execFileSync(icacls, [dir, '/deny', `${EVERYONE}:(RD)`], { stdio: 'pipe', windowsHide: true });
  return () => { execFileSync(icacls, [dir, '/remove:d', EVERYONE], { stdio: 'pipe', windowsHide: true }); };
}
