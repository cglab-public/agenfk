import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The first directory above `dir` holding a `.agenfk` marker, home excepted -
 * as findProjectRoot walks - or null.
 *
 * A spec that needs "a directory with no project above it" can only stage one
 * where this is null. On Windows the temp dir sits inside the user profile, so
 * a machine where AgEnFK is installed has `~/.agenfk` above every temp dir: the
 * real home, which the server's guard skips in production but cannot recognise
 * behind a test's sandbox HOME (#208). CI machines have no such marker.
 */
export function markerAbove(dir: string): string | null {
  for (let d = path.dirname(dir); path.dirname(d) !== d; d = path.dirname(d)) {
    if (d !== os.homedir() && fs.existsSync(path.join(d, '.agenfk'))) return d;
  }
  return null;
}
