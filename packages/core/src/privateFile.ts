import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * Write a file that can hold a secret (BUG cc26b206): ~/.agenfk/config.json
 * carries the JIRA clientSecret, jira-token.json the access and refresh token.
 *
 * Written to a fresh 0600 temp file in the same directory and renamed over the
 * target, never rewritten in place. A rewrite keeps the old inode, so anyone who
 * opened the file while an older release left it 0644 would go on reading every
 * later secret through that descriptor; chmod does not revoke it. The rename
 * also makes the write atomic: a crash cannot leave a truncated config.json.
 * 'wx' so the temp name is ours: a file planted there fails the write instead
 * of donating its permissions.
 */
export function writePrivateFileSync(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A config.json symlinked into a dotfiles repo stays a symlink: write where it
  // points, not over the link (the in-place write this replaced followed it).
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* not there yet */ }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    keepOwner(tmp, target);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

/**
 * A rename hands the file to whoever wrote it. Run as root over a user's home
 * (sudo keeping HOME), that would leave config.json root-owned 0600 and
 * unreadable by the user's own server, so the existing owner is kept.
 */
function keepOwner(tmp: string, target: string): void {
  if (process.getuid?.() !== 0) return;
  try {
    const st = fs.statSync(target);
    fs.chownSync(tmp, st.uid, st.gid);
  } catch { /* no existing file: root's own is right */ }
}

/**
 * Take an existing file to 0600; a missing file is left missing. For files
 * that are not being rewritten (the server tightens them at boot). Throws on
 * any other failure, so the caller decides how loudly to report it.
 */
export function tightenPrivateFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (e: any) {
    if (e?.code !== 'ENOENT' && process.platform !== 'win32') throw e;
  }
}
