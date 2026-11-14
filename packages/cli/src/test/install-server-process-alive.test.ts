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
import { serverProcessAlive, probeServerPort } from '../../../../scripts/install-helpers.mjs';

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
const cim = (rows: Array<[number, string | null]>) =>
  JSON.stringify(rows.map(([ProcessId, CommandLine]) => ({ ProcessId, CommandLine })));

describe('serverProcessAlive on Windows (GitHub #199)', () => {
  it('lists processes through CIM, never wmic', () => {
    const run = vi.fn(() => ok(cim([])));
    serverProcessAlive(run, { platform: 'win32', root: 'C:\\agenfk' });
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
    expect(serverProcessAlive(run, { platform: 'win32', root: 'C:\\Users\\dev\\agenfk' })).toBe(true);
  });

  it('is true for a quoted node.exe path and a single-process listing', () => {
    const run = vi.fn(() => ok(JSON.stringify({ ProcessId: 9, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\agenfk\\packages\\server\\dist\\server.js' })));
    expect(serverProcessAlive(run, { platform: 'win32', root: 'C:\\agenfk' })).toBe(true);
  });

  it('is false when only an editor has the file open, or nothing runs it', () => {
    const editor = vi.fn(() => ok(cim([[5, '"C:\\Program Files\\Microsoft VS Code\\Code.exe" C:\\agenfk\\packages\\server\\dist\\server.js']])));
    expect(serverProcessAlive(editor, { platform: 'win32', root: 'C:\\agenfk' })).toBe(false);
    const none = vi.fn(() => ok(cim([[25044, 'node C:\\agenfk\\packages\\server\\dist\\index.js']])));
    expect(serverProcessAlive(none, { platform: 'win32', root: 'C:\\agenfk' })).toBe(false);
  });

  it('is false, not a crash, when PowerShell is missing or prints nothing', () => {
    expect(serverProcessAlive(vi.fn(() => ({ status: null, stdout: '', error: new Error('ENOENT') })), { platform: 'win32', root: 'C:\\agenfk' })).toBe(false);
    expect(serverProcessAlive(vi.fn(() => ok('')), { platform: 'win32', root: 'C:\\agenfk' })).toBe(false);
  });
});

describe('serverProcessAlive elsewhere keeps asking ps', () => {
  it('reads `ps -ax -o command`', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /opt/agenfk/packages/server/dist/server.js\n'));
    expect(serverProcessAlive(run, { platform: 'linux', root: '/opt/agenfk' })).toBe(true);
    expect(run).toHaveBeenCalledWith('ps', ['-ax', '-o', 'command'], expect.objectContaining({ windowsHide: true }));
  });

  it('matches the path case-sensitively, as POSIX filesystems do', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /opt/agenfk/Packages/Server/Dist/Server.js\n'));
    expect(serverProcessAlive(run, { platform: 'linux', root: '/opt/agenfk' })).toBe(false);
  });
});

// BUG d95009ff: an install into another HOME (a scratch HOME, a second user) saw the developer's
// live server at ~/.agenfk-system - by its process, and by an HTTP probe of port 3000 - decided
// a server of its own had been running and ran `agenfk restart`, which killed it.
describe('the installer looks only for its own server (BUG d95009ff)', () => {
  it('a server run from another install root is not this install\'s', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /Users/dev/.agenfk-system/packages/server/dist/server.js\n'));
    expect(serverProcessAlive(run, { platform: 'darwin', root: '/tmp/scratch/.agenfk-system' })).toBe(false);
    expect(serverProcessAlive(run, { platform: 'darwin', root: '/Users/dev/.agenfk-system' })).toBe(true);
    expect(serverProcessAlive(run, { platform: 'darwin', root: '/Users/dev/.agenfk-system/' })).toBe(true);
  });

  it('a root that only shares a prefix is not the same root', () => {
    const run = vi.fn(() => ok('COMMAND\nnode /opt/agenfk-old/packages/server/dist/server.js\n'));
    expect(serverProcessAlive(run, { platform: 'linux', root: '/opt/agenfk' })).toBe(false);
  });

  it('on Windows the root is matched whichever way the slashes go and in any case', () => {
    const run = vi.fn(() => ok(cim([[7, 'node C:\\Users\\Dev\\.agenfk-system\\packages\\server\\dist\\server.js'], [8, 'node C:\\Users\\other\\.agenfk-system\\packages\\server\\dist\\server.js']])));
    expect(serverProcessAlive(run, { platform: 'win32', root: 'c:/users/dev/.agenfk-system' })).toBe(true);
    expect(serverProcessAlive(vi.fn(() => ok(cim([[8, 'node C:\\Users\\other\\.agenfk-system\\packages\\server\\dist\\server.js']]))), { platform: 'win32', root: 'C:\\Users\\Dev\\.agenfk-system' })).toBe(false);
  });

  it('the caller must say which install it means', () => {
    expect(() => serverProcessAlive(vi.fn(() => ok('')), { platform: 'linux' } as any)).toThrow(/root/);
  });

  it('the HTTP probe is made only for a port this install knows: its port file, or AGENFK_PORT', () => {
    expect(probeServerPort({ env: {}, readPortFile: () => null })).toBeNull();
    expect(probeServerPort({ env: {}, readPortFile: () => '3002' })).toBe('3002');
    expect(probeServerPort({ env: { AGENFK_PORT: '3100' }, readPortFile: () => null })).toBe('3100');
    // The file wins over the env, as the server's own discovery does.
    expect(probeServerPort({ env: { AGENFK_PORT: '3100' }, readPortFile: () => '3002' })).toBe('3002');
    // A blank or garbled file is no port.
    expect(probeServerPort({ env: {}, readPortFile: () => '  ' })).toBeNull();
    expect(probeServerPort({ env: {}, readPortFile: () => '30a0' })).toBeNull();
  });
});
