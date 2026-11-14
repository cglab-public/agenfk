/**
 * @file GitHub #208 phase 5 — a verify command the specs can write once for every OS.
 *
 * The server runs a project's commands with `shell: true`: sh off Windows,
 * cmd.exe on it. `printf`, `touch`, `sleep`, `;`, `$?` and single quotes are
 * sh's, so a spec whose command used them could only pass on POSIX.
 * `nodeCommand(source)` puts the script in a file and answers `node "<file>"`,
 * which both shells read the same way.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeCommand } from './helpers/nodeCommand';

/** As the server runs a verify command. */
const run = (command: string, cwd: string) => spawnSync(command, { shell: true, cwd, encoding: 'utf8', windowsHide: true });

describe('nodeCommand()', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); dir = ''; });

  it('runs its script in the directory the shell runs in', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-nodecmd-'));
    const r = run(nodeCommand(`require('fs').writeFileSync('out.txt', 'it\\'s "here" & 100%')`), dir);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe(`it's "here" & 100%`);
  });

  it('hands back the exit code and the output', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-nodecmd-'));
    const r = run(nodeCommand(`console.log('hello-stream'); process.exit(3)`), dir);
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe('hello-stream');
  });

  it('keeps the script outside the directory it runs in', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-nodecmd-'));
    nodeCommand('process.exit(0)');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
