/**
 * Plain-JS recursive copy for the npx bootstrap and the hub launcher (#349).
 *
 * Replaces fs.cpSync / fs.cp, which abort the process natively on Windows with
 * Node 22 when a path holds a space and non-ASCII letters. This only uses
 * readdir / mkdir / copyFile / readlink / symlink, which are fine there.
 *
 * Semantics follow fs.cpSync({ recursive: true }) as the callers used it:
 *  - `filter(src, dest)` is called on the ROOT first, then on every directory and
 *    file entry; a rejected directory is not descended into.
 *  - existing destination files are overwritten, existing directories are merged,
 *    and nothing in the destination is ever deleted.
 *  - symlinks are recreated as links, not followed.
 *  - errors are thrown, never swallowed.
 *
 * Dependency-free on purpose: it ships in the npx cache before anything is installed.
 */
import fs from 'fs';
import path from 'path';

function copyEntry(src, dst, filter, preserveTimestamps, st) {
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let type;
    if (process.platform === 'win32') {
      try {
        type = fs.statSync(path.resolve(path.dirname(src), target)).isDirectory() ? 'junction' : 'file';
      } catch { type = 'file'; }
    }
    // Node resolves a relative junction target against the process cwd, not the link's
    // directory, so a junction needs an absolute target. Other links keep it verbatim.
    const linkTarget = type === 'junction' ? path.resolve(path.dirname(dst), target) : target;
    try {
      fs.symlinkSync(linkTarget, dst, type);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      // Replace an existing link or file, but never a real directory (nothing is deleted).
      if (fs.lstatSync(dst).isDirectory()) {
        throw new Error(`cannot replace directory ${dst} with a symlink`);
      }
      fs.unlinkSync(dst);
      fs.symlinkSync(linkTarget, dst, type);
    }
    return;
  }

  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      visit(path.join(src, name), path.join(dst, name), filter, preserveTimestamps);
    }
    if (preserveTimestamps) fs.utimesSync(dst, st.atime, st.mtime);
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  if (preserveTimestamps) fs.utimesSync(dst, st.atime, st.mtime);
}

function visit(src, dst, filter, preserveTimestamps) {
  if (filter && !filter(src, dst)) return;
  copyEntry(src, dst, filter, preserveTimestamps, fs.lstatSync(src));
}

export function copyTree(src, dst, { filter, preserveTimestamps = false } = {}) {
  visit(src, dst, filter, preserveTimestamps);
}
