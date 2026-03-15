/**
 * Behavioral tests for `agenfk up` command.
 *
 * Verifies that the up command:
 * - only bootstraps (runs install.mjs) when dist files are actually missing
 * - skips bootstrapping when all dists are already present
 * - forwards --debuglog to install.mjs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockExecSync, mockMkdirSync, mockRmSync, mockReadFileSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockExecSync: vi.fn().mockReturnValue(''),
    mockMkdirSync: vi.fn(),
    mockRmSync: vi.fn(),
    mockReadFileSync: vi.fn().mockReturnValue('{}'),
  }));

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

vi.mock('axios');
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

function resetUpOptions() {
  const upCmd = program.commands.find((c: any) => c.name() === 'up');
  if (upCmd) (upCmd as any)._optionValues = {};
}

/** Make all required dist files appear to exist (normal "already installed" state) */
function setupDistsPresent() {
  mockExistsSync.mockImplementation((p: string) => {
    // start-services.mjs exists, all dist files exist
    return true;
  });
}

/** Make one required dist file appear to be missing (bootstrap needed) */
function setupDistMissing() {
  mockExistsSync.mockImplementation((p: string) => {
    if (p.includes('packages/server/dist/server.js')) return false; // missing
    return true;
  });
}

describe('agenfk up — bootstrap behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpOptions();
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('does NOT run install.mjs when all dist files are already present', async () => {
    setupDistsPresent();

    await program.parseAsync(['node', 'agenfk', 'up']);

    const execCalls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCalled = execCalls.some((cmd) => cmd.includes('install.mjs'));
    expect(installCalled).toBe(false);
  });

  it('runs install.mjs when a required dist file is missing', async () => {
    setupDistMissing();

    await program.parseAsync(['node', 'agenfk', 'up']);

    const execCalls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCalled = execCalls.some((cmd) => cmd.includes('install.mjs'));
    expect(installCalled).toBe(true);
  });

  it('runs install.mjs when start-services.mjs script is missing', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('start-services.mjs')) return false; // missing
      return true;
    });

    await program.parseAsync(['node', 'agenfk', 'up']);

    const execCalls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCalled = execCalls.some((cmd) => cmd.includes('install.mjs'));
    expect(installCalled).toBe(true);
  });

  it('forwards --debuglog to install.mjs when bootstrap is needed', async () => {
    setupDistMissing();

    await program.parseAsync(['node', 'agenfk', 'up', '--debuglog']);

    const execCalls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCall = execCalls.find((cmd) => cmd.includes('install.mjs'));
    expect(installCall).toBeDefined();
    expect(installCall).toContain('--debuglog');
  });

  it('does NOT include --debuglog in install.mjs call when flag is absent', async () => {
    setupDistMissing();

    await program.parseAsync(['node', 'agenfk', 'up']);

    const execCalls: string[] = mockExecSync.mock.calls.map((c: any[]) => c[0] as string);
    const installCall = execCalls.find((cmd) => cmd.includes('install.mjs'));
    expect(installCall).toBeDefined();
    expect(installCall).not.toContain('--debuglog');
  });

  it('starts services via spawn (not execSync) regardless of bootstrap state', async () => {
    setupDistsPresent();

    await program.parseAsync(['node', 'agenfk', 'up']);

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      ['scripts/start-services.mjs'],
      expect.objectContaining({ cwd: expect.any(String) })
    );
  });
});
