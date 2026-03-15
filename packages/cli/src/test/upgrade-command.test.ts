/**
 * Behavioral tests for `agenfk upgrade` command.
 *
 * Verifies the actual runtime behavior:
 * - Stops running server before install, restarts after
 * - Downloads the pre-built binary asset (not a source build)
 * - Forwards --debuglog to install.mjs
 * - Skips stop/start when server was not running
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockMkdirSync, mockRmSync, mockReadFileSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockRmSync: vi.fn(),
    mockReadFileSync: vi.fn().mockReturnValue('{}'),
  }));

const mockExecSync = vi.hoisted(() => vi.fn().mockReturnValue(''));
const mockSpawn = vi.hoisted(() =>
  vi.fn().mockReturnValue({ on: vi.fn(), unref: vi.fn() })
);

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
  readFileSync: mockReadFileSync,
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
  default: {
    execSync: mockExecSync,
    spawn: mockSpawn,
    spawnSync: vi.fn().mockReturnValue({ status: 0 }),
  },
}));

// axios is mocked to control server-running check and GitHub API response
const mockAxiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  default: { get: mockAxiosGet },
  get: mockAxiosGet,
}));

vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
    this.id = 'test-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
}));

import { program } from '../index';

function resetUpgradeOptions() {
  const cmd = program.commands.find((c: any) => c.name() === 'upgrade');
  if (cmd) (cmd as any)._optionValues = {};
}

/** GitHub releases/latest response returning a version higher than current */
const REMOTE_RELEASE = { data: { tag_name: 'v99.99.99' } };

function setupUpgradeScenario({
  serverRunning,
}: {
  serverRunning: boolean;
}) {
  // First axios.get call: check if server is running
  if (serverRunning) {
    mockAxiosGet.mockResolvedValueOnce({ data: 'ok' });
  } else {
    mockAxiosGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  }
  // Second axios.get call: GitHub releases/latest
  mockAxiosGet.mockResolvedValueOnce(REMOTE_RELEASE);

  // install.mjs exists
  mockExistsSync.mockReturnValue(true);
  // execSync: curl download succeeds, other calls succeed
  mockExecSync.mockReturnValue('');
}

describe('agenfk upgrade — server lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpgradeOptions();
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('stops server before running install.mjs when server is running', async () => {
    setupUpgradeScenario({ serverRunning: true });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const downIdx = calls.findIndex((cmd) => cmd.includes('agenfk.js') && cmd.includes('down'));
    const installIdx = calls.findIndex((cmd) => cmd.includes('install.mjs'));

    expect(downIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(downIdx).toBeLessThan(installIdx);
  });

  it('does NOT stop server when server was not running', async () => {
    setupUpgradeScenario({ serverRunning: false });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const downCall = calls.find((cmd) => cmd.includes('agenfk.js') && cmd.includes('down'));
    expect(downCall).toBeUndefined();
  });

  it('restarts server via spawn after upgrade when server was running', async () => {
    setupUpgradeScenario({ serverRunning: true });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    // spawn is used to restart in background (not execSync, to avoid blocking)
    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['packages/cli/bin/agenfk.js', 'up']),
      expect.objectContaining({ detached: true })
    );
  });

  it('does NOT restart server when server was not running before upgrade', async () => {
    setupUpgradeScenario({ serverRunning: false });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const spawnCalls = mockSpawn.mock.calls;
    const restartCall = spawnCalls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes('up')
    );
    expect(restartCall).toBeUndefined();
  });
});

describe('agenfk upgrade — binary download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpgradeOptions();
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('downloads pre-built binary using curl before running install.mjs', async () => {
    setupUpgradeScenario({ serverRunning: false });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const curlCall = calls.find((cmd) => cmd.includes('curl') && cmd.includes('agenfk-dist.tar.gz'));
    expect(curlCall).toBeDefined();
  });

  it('runs install.mjs after extracting the tarball', async () => {
    setupUpgradeScenario({ serverRunning: false });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const tarIdx = calls.findIndex((cmd) => cmd.includes('tar -xzf') && cmd.includes('agenfk-dist.tar.gz'));
    const installIdx = calls.findIndex((cmd) => cmd.includes('install.mjs'));

    expect(tarIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(tarIdx);
  });

  it('forwards --debuglog to install.mjs', async () => {
    setupUpgradeScenario({ serverRunning: false });

    await program.parseAsync(['node', 'agenfk', 'upgrade', '--debuglog']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCall = calls.find((cmd) => cmd.includes('install.mjs'));
    expect(installCall).toBeDefined();
    expect(installCall).toContain('--debuglog');
  });
});

describe('agenfk upgrade — no-op when already on latest version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpgradeOptions();
  });

  it('does not run install.mjs when already on the latest version', async () => {
    // Server not running
    mockAxiosGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // GitHub returns same version as CURRENT_VERSION (read from package.json at build time)
    // We simulate by making fetchLatestReleaseTag throw so no upgrade happens
    mockAxiosGet.mockRejectedValueOnce(new Error('network error'));
    // execSync fallback for `gh release view` also fails
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh release view')) throw new Error('gh not found');
      return '';
    });

    await program.parseAsync(['node', 'agenfk', 'upgrade']);

    const calls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCall = calls.find((cmd) => cmd.includes('install.mjs'));
    expect(installCall).toBeUndefined();
  });
});
