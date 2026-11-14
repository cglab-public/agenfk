import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A verify command that runs `source` with node, read the same way by sh and
 * by cmd.exe (GitHub #208).
 *
 * The server runs a project's commands with `shell: true` - sh off Windows,
 * cmd.exe on it - so `printf`, `touch`, `sleep`, `;`, `$?` and single quotes
 * only ever worked on POSIX. The script goes in a file of its own, outside any
 * tree a spec checks for changes, and the command is `node "<file>"`. It runs in
 * the directory the server runs the command in.
 */
export function nodeCommand(source: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cmd-')), 'command.cjs');
  fs.writeFileSync(file, source);
  return `node "${file}"`;
}
