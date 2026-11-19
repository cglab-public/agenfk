/**
 * Reading, on the host, a file the sandboxed session can write (CGLAB-696): only a regular
 * file, never through a link in its last component, never blocking on a FIFO, never past `max`
 * bytes. Null for anything else. No imports but fs, so a test can run it in a child process.
 */
import fs from 'fs';

/**
 * A JSON config the host reads (a client's, which a session may have written: the project's
 * opencode.json): through links to a regular file, never blocking, never past `max`. Null otherwise.
 */
export function readJsonFile(file: string, max = 16 * 1024 * 1024): unknown {
  try {
    const buf = readRegularFile(fs.realpathSync(file), max);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    return null;
  }
}

export function readRegularFile(file: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
