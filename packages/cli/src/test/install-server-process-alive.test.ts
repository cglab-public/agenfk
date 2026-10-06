/**
 * GitHub #199, the installer's side: an upgrade restarts the API server when it
 * was running before, and its second signal for that (the HTTP probe being the
 * first) asks the OS whether a server process is alive. On Windows that asked
 * `wmic`, which current Windows 11 builds no longer ship, and under Git Bash it
 * asked `ps`, which cannot see a native node.exe - so the answer was always no.
 *
 * Contract: on win32, whatever the shell, the check lists processes through CIM
 * and recognises a node or bun process running the server, by command line.
 */
import { describe, it, expect, vi } from 'vitest';
import { serverProcessAlive } from '../../../../scripts/install-helpers.mjs';

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
const cim = (rows: Array<[number, string | null]>) =>
  JSON.stringify(rows.map(([ProcessId, CommandLine]) => ({ ProcessId, CommandLine })));

describe('serverProcessAlive on Windows (GitHub #199)', () => {
  it('lists processes through CIM, never wmic', () => {
    const run = vi.fn(() => ok(cim([])));
    serverProcessAlive(run, { platform: 'win32' });
    expect(run).toHaveBeenCalledTimes(1);
    const [file, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(file).toMatch(/powershell/i);
    expect(args.join(' ')).toMatch(/Get-CimInstance\s+Win32_Process/);
    expect(run.mock.calls.flat().join(' ')).not.toMatch(/wmic/i);
    // A hung WMI service must not hold the upgrade forever.
    expect((run.mock.calls[0] as unknown[])[2]).toMatchObject({ timeout: expect.any(Number), windowsHide: true });
  });

  it('is true for node running the server, with Windows backslashes', () => {
    const run = vi.fn(() => ok(cim([[4, null], [23508, 'node C:\\Users\\dev\\agenfk\\packages\\server\\dist\\server.js']])));
    expect(serverProcessAlive(run, { platform: 'win32' })).toBe(true);
  });

  it('is true for a quoted node.exe path and a single-process listing', () => {
    const run = vi.fn(() => ok(JSON.stringify({ ProcessId: 9, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\agenfk\\packages\\server\\dist\\server.js' })));
    expect(serverProcessAlive(run, { platform: 'win32' })).toBe(true);
  });

  it('is false when only an editor has the file open, or nothing runs it', () => {
    const editor = vi.fn(() => ok(cim([[5, '"C:\\Program Files\\Microsoft VS Code\\Code.exe" C:\\agenfk\\packages\\server\\dist\\server.js']])));
    expect(serverProcessAlive(editor, { platform: 'win32' })).toBe(false);
    const none = vi.fn(() => ok(cim([[25044, 'node C:\\agenfk\\packages\\server\\dist\\index.js']])));
    expect(serverProcessAlive(none, { platform: 'win32' })).toBe(false);
  });

  it('is false, not a crash, when PowerShell is missing or prints nothing', () => {
    expect(serverProcessAlive(vi.fn(() => ({ status: null, stdout: '', error: new Error('ENOENT') })), { platform: 'win32' })).toBe(false);
    expect(serverProcessAlive(vi.fn(() => ok('')), { platform: 'win32' })).toBe(false);
  });
});

describe('serverProcessAlive elsewhere keeps asking ps', () => {
  it('reads `ps -ax -o command`', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /opt/agenfk/packages/server/dist/server.js\n'));
    expect(serverProcessAlive(run, { platform: 'linux' })).toBe(true);
    expect(run).toHaveBeenCalledWith('ps', ['-ax', '-o', 'command'], expect.objectContaining({ windowsHide: true }));
  });

  it('matches the path case-sensitively, as POSIX filesystems do', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /opt/agenfk/Packages/Server/Dist/Server.js\n'));
    expect(serverProcessAlive(run, { platform: 'linux' })).toBe(false);
  });
});
