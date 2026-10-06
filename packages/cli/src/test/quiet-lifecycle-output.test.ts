/**
 * e04dac92 (CGLAB-164): `agenfk up/down/restart/kill/upgrade` say what happened
 * in a line or two.
 *
 * They used to print emoji step headers plus the child processes' own output
 * (a `restart` printed `down`'s three lines, then `up`'s), and `down` claimed
 * "✓ API server stopped / Stopped 1 service(s)" even when nothing was running,
 * because the kill helper never reported whether it killed anything. It now
 * reports what it killed and what it could not, and `down`/`kill` say which.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';

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
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let killSpy: ReturnType<typeof vi.spyOn>;

function resetCommanderOptions(cmd: any) {
  (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

/** `ps -ef` as it looks with (or without) a running agenfk server. */
function psListing(serverRunning: boolean): string {
  const rows = ['UID   PID  PPID   C STIME   TTY           TIME CMD', '  501  111     1   0 10:00AM ??  0:00.01 /sbin/launchd'];
  if (serverRunning) rows.push('  501 4242     1   0 10:00AM ??  0:01.00 node /x/agenfk-system/packages/server/dist/server.js');
  return rows.join('\n');
}

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() };
}

beforeEach(() => {
  resetCommanderOptions(program);
  out = [];
  const capture = (...a: any[]) => { out.push(strip(a.map(String).join(' '))); };
  logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
  errSpy = vi.spyOn(console, 'error').mockImplementation(capture);
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset().mockImplementation(fakeChild);
  mockSpawnSync.mockReset().mockReturnValue({ status: 0 });
});

afterEach(() => {
  process.exitCode = undefined;
  logSpy.mockRestore();
  errSpy.mockRestore();
  killSpy.mockRestore();
});

const nonEmpty = () => out.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);

/** The cases it is called in are the POSIX path (`ps -ef`, `lsof`), whatever the host; Windows is pinned on its own. */
function onPosix() {
  const realPlatform = process.platform;
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux' }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); });
}

describe('agenfk down', () => {
  onPosix();

  it('prints one line when it stopped the server, and really killed it', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(true) : ''));
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(nonEmpty()).toEqual(['✓ AgEnFK stopped']);
  });

  it('says it was not running when there was nothing to stop', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(false) : ''));
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(killSpy).not.toHaveBeenCalled();
    expect(nonEmpty()).toEqual(['AgEnFK was not running']);
  });

  it('does not claim "not running" when it could not stop the server - it warns and fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(true) : ''));
    killSpy.mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    await program.parseAsync(['node', 'agenfk', 'down']);
    expect(nonEmpty()).toEqual(['⚠ Could not stop PID 4242: EPERM']);
    expect(process.exitCode).toBe(1);
  });
});

describe('agenfk kill', () => {
  onPosix();

  it('prints one line saying how many it killed', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(true) : ''));
    await program.parseAsync(['node', 'agenfk', 'kill']);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(nonEmpty()).toEqual(['✓ Killed 1 AgEnFK process']);
  });

  it('says nothing was running when nothing was', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(false) : ''));
    await program.parseAsync(['node', 'agenfk', 'kill']);
    expect(nonEmpty()).toEqual(['No AgEnFK processes were running']);
  });
});

describe('the kill helpers only kill what is ours', () => {
  onPosix();

  it('kills the process LISTENING on the port, never a browser or the desktop app connected to it', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'ps -ef') return psListing(false);
      if (/^lsof -t -iTCP:3000 -sTCP:LISTEN$/.test(cmd)) return '84080\n';
      if (/^lsof .*-sTCP:LISTEN$/.test(cmd)) return ''; // nothing listens on the other ports
      if (/^lsof .*:3000$/.test(cmd)) return '63131\n84080\n'; // any socket on :3000, clients included
      return '';
    });
    await program.parseAsync(['node', 'agenfk', 'kill']);
    expect(killSpy).toHaveBeenCalledWith(84080, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(63131, 'SIGKILL');
  });

  describe('on native Windows', () => {
    const realPlatform = process.platform;
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      // Processes are listed through CIM (#199); kill-helpers-windows.test.ts covers that listing.
      mockExecFileSync.mockImplementation(() => '[]');
    });
    afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); });

    it('kills a listener once (IPv4 + IPv6 lines), not a port that merely starts with the same digits', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (/^netstat /.test(cmd)) return [
          '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       900',
          '  TCP    [::]:3000              [::]:0                 LISTENING       900',
          '  TCP    0.0.0.0:30001          0.0.0.0:0              LISTENING       901',
        ].join('\r\n');
        return '';
      });
      await program.parseAsync(['node', 'agenfk', 'kill']);
      const taskkills = mockExecSync.mock.calls.map(([c]) => String(c)).filter((c) => c.startsWith('taskkill'));
      expect(taskkills).toEqual(['taskkill /F /PID 900']);
      expect(nonEmpty()).toEqual(['✓ Killed 1 AgEnFK process']);
    });

    it("treats taskkill's 'not found' as already gone", async () => {
      mockExecFileSync.mockImplementation(() => JSON.stringify([{ ProcessId: 4242, CommandLine: 'node C:\\x\\packages\\server\\dist\\server.js' }]));
      mockExecSync.mockImplementation((cmd: string) => {
        if (/^taskkill/.test(cmd)) throw Object.assign(new Error('not found'), { status: 128 });
        return '';
      });
      await program.parseAsync(['node', 'agenfk', 'down']);
      expect(nonEmpty()).toEqual(['AgEnFK was not running']);
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe('agenfk restart', () => {
  it("prints nothing of its own: down's line is dropped, up runs in the foreground and prints the one line", async () => {
    await program.parseAsync(['node', 'agenfk', 'restart']);
    expect(nonEmpty()).toEqual([]);
    const downCall = mockExecSync.mock.calls.find(([cmd]) => /agenfk\.js down/.test(String(cmd)));
    expect(downCall?.[1]?.stdio).toEqual(['ignore', 'pipe', 'inherit']);
    // Foreground, on the terminal: start-services' line - and any warning - reaches the user.
    const upCall = mockSpawnSync.mock.calls.find(([, args]) => (args as string[]).includes('up'));
    expect(upCall?.[2]?.stdio).toBe('inherit');
    expect(mockSpawn.mock.calls.find(([, args]) => (args as string[]).includes('up'))).toBeUndefined();
  });

  it("passes on a warning down raised", async () => {
    mockExecSync.mockImplementation((cmd: string) => (/agenfk\.js down/.test(cmd) ? '⚠ Could not stop PID 7: EPERM\n' : ''));
    await program.parseAsync(['node', 'agenfk', 'restart']);
    expect(nonEmpty()).toEqual(['⚠ Could not stop PID 7: EPERM']);
  });

  it('fails when up fails', async () => {
    mockSpawnSync.mockReturnValue({ status: 3 });
    await program.parseAsync(['node', 'agenfk', 'restart']);
    expect(nonEmpty()).toEqual(['Failed to restart: agenfk up exited 3']);
    expect(process.exitCode).toBe(1);
  });
});

describe('agenfk up', () => {
  onPosix();

  it('prints nothing of its own before handing over to the service script (which prints the one line)', async () => {
    mockExecSync.mockImplementation((cmd: string) => (cmd === 'ps -ef' ? psListing(false) : ''));
    await program.parseAsync(['node', 'agenfk', 'up', '--quiet']);
    const start = mockSpawn.mock.calls.find(([, args]) => (args as string[]).some((a) => /start-services\.mjs$/.test(a)));
    expect(start).toBeDefined(); // guard: it really got as far as starting
    expect(nonEmpty()).toEqual([]);
  });
});

describe('agenfk upgrade', () => {
  const CURRENT = program.version() as string;
  let gitSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    /*
     * As an INSTALLED copy. These run from this repository, which is a git
     * checkout, and an upgrade refuses one (658ef023, pinned in
     * upgradeDevCheckout.test.ts). Here the install root's .git is hidden so
     * the installed-copy path - the one these lines describe - is what runs.
     */
    const realExists = fs.existsSync;
    const repoGit = path.resolve(__dirname, '../../../../.git');
    gitSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => (path.resolve(String(p)) === repoGit ? false : realExists(p)));
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (/releases\/tags\/v9\.9\.9$/.test(url)) return { status: 200, data: { tag_name: 'v9.9.9' } } as any;
      throw new Error('ECONNREFUSED'); // the local server is not running
    });
    mockExecSync.mockImplementation(() => '');
  });
  afterEach(() => { gitSpy?.mockRestore(); });

  it('prints two lines: what it is doing, and that it is done', async () => {
    await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', '9.9.9']);
    expect(nonEmpty()).toEqual([`Upgrading AgEnFK ${CURRENT} → 9.9.9...`, '✓ Upgraded to 9.9.9']);
  });

  it('runs the installer with --quiet, so its own summary is the only one', async () => {
    await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', '9.9.9']);
    const install = mockExecSync.mock.calls.find(([cmd]) => /install\.mjs/.test(String(cmd)));
    expect(String(install?.[0])).toMatch(/--quiet/);
  });

  it('with --debuglog, runs the installer verbosely instead', async () => {
    await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', '9.9.9', '--debuglog']);
    const install = mockExecSync.mock.calls.find(([cmd]) => /install\.mjs/.test(String(cmd)));
    expect(String(install?.[0])).toMatch(/--debuglog/);
    expect(String(install?.[0])).not.toMatch(/--quiet/);
  });

  it('with --json, prints the JSON result and nothing else', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { writes.push(String(chunk)); return true; });
    try {
      await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', '9.9.9', '--json']);
    } finally {
      writeSpy.mockRestore();
    }
    expect(nonEmpty()).toEqual([]);
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ status: 'upgraded', fromVersion: CURRENT, toVersion: '9.9.9' }]);
  });

  it('says why the pre-built binary could not be installed before falling back', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (/^tar /.test(cmd)) throw Object.assign(new Error('Command failed: tar'), { stderr: 'tar: agenfk-system: Cannot open: No space left on device\n' });
      return '';
    });
    await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', '9.9.9']);
    expect(nonEmpty()[1]).toMatch(/^⚠ Could not install the pre-built binary \(.*No space left on device.*\), falling back/);
  });

  it('prints one line when already on the requested version', async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (/releases\/tags\//.test(url)) return { status: 200, data: { tag_name: `v${CURRENT}` } } as any;
      throw new Error('ECONNREFUSED');
    });
    await program.parseAsync(['node', 'agenfk', 'upgrade', '--version', CURRENT]);
    expect(nonEmpty()).toHaveLength(1);
    expect(nonEmpty()[0]).toMatch(new RegExp(`already on ${CURRENT.replace(/\./g, '\\.')}`));
  });
});
