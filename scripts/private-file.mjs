import { writeFileSync, renameSync, unlinkSync, mkdirSync, realpathSync, statSync, chownSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * The installer's copy of @agenfk/core's writePrivateFileSync (BUG cc26b206):
 * install.mjs runs before any package is built, so it cannot import core.
 * ~/.agenfk/config.json carries the JIRA clientSecret. Written 0600 to a fresh
 * temp file and renamed over the target, never rewritten in place, so a
 * descriptor opened while an older release left the file 0644 cannot read what
 * is written now.
 */
export function writePrivateFileSync(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  // A symlinked config.json stays a symlink: write where it points.
  let target = file;
  try { target = realpathSync(file); } catch { /* not there yet */ }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Run as root over a user's home, keep the file the user's (a rename would hand it to root).
    if (process.getuid?.() === 0) {
      try { const st = statSync(target); chownSync(tmp, st.uid, st.gid); } catch { /* no existing file */ }
    }
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}
