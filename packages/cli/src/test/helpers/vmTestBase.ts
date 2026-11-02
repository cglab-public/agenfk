import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where a test that may start a real smolvm machine keeps its files. Not under /tmp on Linux: the
 * guest has its own /tmp, world-writable, and the session's home under it is refused - rightly, a
 * real home is never there (the session's ~/.agenfk must be root's alone in the machine). macOS's
 * temp dir (/var/folders/...) is no such path in the guest.
 */
export function vmTestBase(): string {
  if (process.platform !== 'linux') return os.tmpdir();
  const base = path.join(os.userInfo().homedir, '.agenfk-vm-tests');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}
