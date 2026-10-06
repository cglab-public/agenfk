/**
 * GitHub #199: on Windows `agenfk down` could not see the server it had to stop.
 *
 * Node is a native Windows process under Git Bash too (process.platform is
 * win32 there), yet with MSYSTEM set the kill helpers took the POSIX branch:
 * `ps -ef` and `lsof`, which list only MSYS processes, so the native node.exe
 * server was never found - `down` said "AgEnFK was not running", and `up`
 * could not free port 3000, so `restart` started a second server on 3001
 * against the same database. Outside Git Bash the helpers used `wmic`, which
 * is gone from current Windows 11 builds.
 *
 * Contract: on win32, whatever the shell, processes are listed through CIM
 * (PowerShell's Get-CimInstance Win32_Process) and listeners through netstat;
 * a process is matched on its command line whichever way its slashes go.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecSync, mockExecFileSync, mockSpawn, mockSpawnSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn(),
}));

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
  default: { execSync: mockExecSync, execFileSync: mockExecFileSync, spawn: mockSpawn, spawnSync: mockSpawnSync },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const SERVER = 'node C:\\Users\\dev\\agenfk\\packages\\server\\dist\\server.js';
const MCP = 'node C:\\Users\\dev\\agenfk\\packages\\server\\dist\\index.js';

/** What `Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json` prints. */
const cim = (rows: Array<[number, string | null]>) =>
  JSON.stringify(rows.map(([ProcessId, CommandLine]) => ({ ProcessId, CommandLine })));

/** True for the CIM process listing, however the helper spells the PowerShell call. */
const isCimListing = (file: unknown, args: unknown) =>
  /powershell/i.test(String(file)) && /Get-CimInstance\s+Win32_Process/.test((args as string[] ?? []).join(' '));

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let killSpy: ReturnType<typeof vi.spyOn>;
const realPlatform = process.platform;
const realMsystem = process.env.MSYSTEM;
const realMingwPrefix = process.env.MINGW_PREFIX;

function resetCommanderOptions(cmd: any) {
  (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

/** Lists `listing` through CIM; taskkill succeeds; netstat shows `netstat`. Records every command. */
function windowsMachine({ listing, netstat = '' }: { listing: string | Error; netstat?: string }) {
  mockExecFileSync.mockImplementation((file: string, args: string[]) => {
    if (isCimListing(file, args)) {
      if (listing instanceof Error) throw listing;
      return listing;
    }
    throw new Error(`unexpected execFileSync ${file} ${args?.join(' ')}`);
  });
  mockExecSync.mockImplementation((cmd: string) => {
    if (/^netstat /.test(cmd)) {
      if (!netstat) throw Object.assign(new Error('findstr found nothing'), { status: 1 });
      return netstat;
    }
    if (/^taskkill /.test(cmd)) return '';
    if (/^(wmic|ps |lsof|pgrep)/.test(cmd)) throw new Error(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command`);
    return '';
  });
}

const shellCommands = () => mockExecSync.mock.calls.map(([c]) => String(c));
const taskkills = () => shellCommands().filter((c) => c.startsWith('taskkill'));
const nonEmpty = () => out.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);

beforeEach(() => {
  resetCommanderOptions(program);
  out = [];
  const capture = (...a: any[]) => { out.push(strip(a.map(String).join(' '))); };
  logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
  errSpy = vi.spyOn(console, 'error').mockImplementation(capture);
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset().mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
  mockSpawnSync.mockReset().mockReturnValue({ status: 0 });
  Object.defineProperty(process, 'platform', { value: 'win32' });
});

afterEach(() => {
  process.exitCode = undefined;
  logSpy.mockRestore();
  errSpy.mockRestore();
  killSpy.mockRestore();
  Object.defineProperty(process, 'platform', { value: realPlatform });
  if (realMsystem === undefined) delete process.env.MSYSTEM; else process.env.MSYSTEM = realMsystem;
  if (realMingwPrefix === undefined) delete process.env.MINGW_PREFIX; else process.env.MINGW_PREFIX = realMingwPrefix;
});

describe.each([
  ['PowerShell or cmd', undefined],
  ['Git Bash (MSYSTEM=UCRT64)', 'UCRT64'],
])('agenfk down on Windows, from %s (GitHub #199)', (_shell, msystem) => {
  beforeEach(() => {
    if (msystem) process.env.MSYSTEM = msystem;
    else { delete process.env.MSYSTEM; delete process.env.MINGW_PREFIX; }
  });

  it('finds the native server through CIM and stops it with taskkill', async () => {
    windowsMachine({ listing: cim([[4, null], [23508, SERVER], [25044, MCP]]) });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(taskkills()).toEqual(['taskkill /F /PID 23508']);
    expect(nonEmpty()).toEqual(['✓ AgEnFK stopped']);
  });

  it('never asks wmic, ps or lsof, which cannot see it (or no longer exist)', async () => {
    windowsMachine({ listing: cim([[23508, SERVER]]) });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(shellCommands().filter((c) => /^(wmic|ps |lsof|pgrep)/.test(c))).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('matches the command line whatever its casing (Windows paths are case-insensitive)', async () => {
    windowsMachine({ listing: cim([[777, '"C:\\Program Files\\nodejs\\node.exe" C:\\AgEnFK\\Packages\\Server\\Dist\\Server.js']]) });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(taskkills()).toEqual(['taskkill /F /PID 777']);
  });

  it('reads a listing of a single process (ConvertTo-Json prints an object, not an array)', async () => {
    windowsMachine({ listing: JSON.stringify({ ProcessId: 23508, CommandLine: SERVER }) });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(taskkills()).toEqual(['taskkill /F /PID 23508']);
  });

  it('says it was not running when no process carries the server path', async () => {
    windowsMachine({ listing: cim([[4, null], [25044, MCP]]) });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(taskkills()).toEqual([]);
    expect(nonEmpty()).toEqual(['AgEnFK was not running']);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not claim "not running" when it could not list processes - it warns and fails', async () => {
    windowsMachine({ listing: new Error('powershell.exe not found') });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(nonEmpty().join('\n')).toMatch(/⚠ Could not stop could not list processes: powershell\.exe not found/);
    expect(nonEmpty()).not.toContain('AgEnFK was not running');
    expect(process.exitCode).toBe(1);
  });
});

describe('agenfk kill and up from Git Bash free the port through netstat (GitHub #199)', () => {
  const NETSTAT = [
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       23508',
    '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       31000',
  ].join('\r\n');

  beforeEach(() => { process.env.MSYSTEM = 'UCRT64'; });

  it('kill stops the listener on the API port and the servers found by path, not other listeners', async () => {
    windowsMachine({ listing: cim([[23508, SERVER], [25044, MCP]]), netstat: NETSTAT });
    await program.parseAsync(['node', 'agenfk', 'kill']);
    expect(shellCommands().some((c) => /^lsof/.test(c))).toBe(false);
    expect(taskkills()).toContain('taskkill /F /PID 23508');
    expect(taskkills()).toContain('taskkill /F /PID 25044');
    expect(taskkills()).not.toContain('taskkill /F /PID 31000');
  });

  it('up frees port 3000 before starting, so restart cannot leave a second server on 3001', async () => {
    windowsMachine({ listing: cim([]), netstat: NETSTAT });
    await program.parseAsync(['node', 'agenfk', 'up', '--quiet']);
    expect(taskkills()).toEqual(['taskkill /F /PID 23508']);
  });
});
