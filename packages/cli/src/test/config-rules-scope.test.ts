import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = mockCapture;
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: mockSpawnSync,
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: mockSpawnSync },
}));

vi.mock('axios');
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));

import { program } from '../index';
import * as path from 'path';
import * as os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'config.json');

describe('agenfk rules install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs project-scoped rules by default and saves rulesScope to config', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ dbPath: '/some/path' }));

    await program.parseAsync(['node', 'agenfk', 'rules', 'install']);

    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('project');
    expect(written.dbPath).toBe('/some/path');
  });

  it('installs global-scoped rules with --global flag', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('global');
  });

  it('runs install.mjs with --rules-scope and --rules-only', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        expect.stringContaining('install.mjs'),
        '--rules-scope=global',
        '--rules-only',
      ]),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('creates config when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockReadFileSync).not.toHaveBeenCalled();
    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('global');
  });
});

describe('agenfk rules uninstall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs uninstall.mjs with --rules-scope=project and --rules-only by default', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'project' }));

    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        expect.stringContaining('uninstall.mjs'),
        '--rules-scope=project',
        '--rules-only',
      ]),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('runs uninstall.mjs with --rules-scope=global when --global flag is used', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        '--rules-scope=global',
        '--rules-only',
      ]),
      expect.anything()
    );
  });

  it('clears rulesScope from config after uninstalling the active scope', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global', dbPath: '/p' }));

    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    // writeFileSync should be called to update config (removing rulesScope)
    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBeUndefined();
    expect(written.dbPath).toBe('/p');
  });
});

describe('agenfk rules status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports "global" when config has rulesScope=global', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global' }));

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'rules', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('global'));
    spy.mockRestore();
  });

  it('reports "project" when config has rulesScope=project', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'project' }));

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'rules', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('project'));
    spy.mockRestore();
  });

  it('reports "not configured" when no rulesScope is set', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'rules', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    spy.mockRestore();
  });
});
