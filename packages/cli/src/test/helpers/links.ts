import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Links the specs make, on every OS (GitHub #208 phase 3).
 *
 * `fs.symlinkSync` needs admin or Developer Mode on Windows and fails there
 * with EPERM. A directory JUNCTION needs neither, and it is what Windows users
 * and their tools actually make: lstat calls it a symbolic link and readlink
 * reads it, so a product that refuses to follow a symlink must refuse it too.
 * Off Windows this is the plain symlink it always was.
 *
 * A relative target is read against the link's own directory, as a symlink's
 * is. (Node resolves a junction's target against the process cwd, which would
 * point `linkDir('.', tests/l0)` somewhere else entirely.)
 */
export function linkDir(target: string, link: string): void {
  if (process.platform === 'win32') {
    fs.symlinkSync(path.resolve(path.dirname(link), target), link, 'junction');
  } else {
    fs.symlinkSync(target, link);
  }
}

let symlinkAllowed: boolean | undefined;

/**
 * Whether this process may make a real (file) symlink. A junction cannot point
 * at a file, so a spec that needs a file link runs where this is true - Linux
 * and macOS always, Windows with Developer Mode or admin - and says why it is
 * skipped where it is not. Probed once, in a temp dir it removes.
 */
export function canSymlink(): boolean {
  if (symlinkAllowed !== undefined) return symlinkAllowed;
  if (process.platform !== 'win32') return (symlinkAllowed = true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-canSymlink-'));
  try {
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'), 'file');
    symlinkAllowed = fs.lstatSync(path.join(dir, 'l')).isSymbolicLink();
  } catch {
    symlinkAllowed = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return symlinkAllowed;
}
