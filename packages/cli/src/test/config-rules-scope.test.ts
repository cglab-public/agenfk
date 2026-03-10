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

describe('agenfk config set rulesScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts "global" and writes rulesScope to config', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ dbPath: '/some/path' }));

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'global']);

    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('global');
    // Preserves existing keys
    expect(written.dbPath).toBe('/some/path');
  });

  it('accepts "project" and writes rulesScope to config', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'project']);

    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('project');
  });

  it('rejects invalid values (not "global" or "project")', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(
      program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'banana'])
    ).rejects.toThrow('exit');

    // Should NOT have written anything
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('creates config when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'project']);

    expect(mockReadFileSync).not.toHaveBeenCalled();
    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.rulesScope).toBe('project');
  });

  it('re-runs install.mjs with --rules-scope to migrate rules', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'project']);

    // Should have called spawnSync with install.mjs and --rules-scope=project
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        expect.stringContaining('install.mjs'),
        '--rules-scope=project',
      ]),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('passes --rules-only flag so install.mjs only updates rules (no full reinstall)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'rulesScope', 'global']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        '--rules-scope=global',
        '--rules-only',
      ]),
      expect.anything()
    );
  });
});
