/**
 * TDD tests for agenfk pause / resume commands.
 * Tests are written first; they will fail until the implementation is in place.
 *
 * Covers:
 *  - getPausedIntegrations() config helper
 *  - setPausedIntegrations() config helper
 *  - agenfk pause <platform>
 *  - agenfk pause all
 *  - agenfk resume <platform>
 *  - agenfk resume all
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------
const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

const { mockExit } = vi.hoisted(() => ({
  mockExit: vi.fn(),
}));

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: vi.fn(),
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: mockSpawnSync,
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: mockSpawnSync },
}));

vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));

vi.mock('axios');

// Mock process.exit so commands don't terminate the test process
vi.spyOn(process, 'exit').mockImplementation(mockExit as any);

import { program } from '../index';
import * as path from 'path';
import * as os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'config.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function lastWrittenConfig(): any {
  const calls = mockWriteFileSync.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const [filePath, content] = calls[i] as [string, string];
    if (filePath === CONFIG_PATH) {
      return JSON.parse(content);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config helper: getPausedIntegrations / setPausedIntegrations
// ---------------------------------------------------------------------------
describe('getPausedIntegrations config helper', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when config file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    // Trigger resume all with nothing to pause to exercise the helper
    await program.parseAsync(['node', 'agenfk', 'resume', 'all', '--yes']);
    // Should not crash and should not call install (nothing to resume)
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs')]),
      expect.anything()
    );
  });

  it('returns [] when config exists but has no pausedIntegrations field', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global' }));
    await program.parseAsync(['node', 'agenfk', 'resume', 'all', '--yes']);
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs')]),
      expect.anything()
    );
  });
});

describe('setPausedIntegrations config helper', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges pausedIntegrations into existing config without overwriting other fields', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global', dbPath: '/db' }));
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'claude', '--yes']);

    const written = lastWrittenConfig();
    expect(written).not.toBeNull();
    expect(written.rulesScope).toBe('global');
    expect(written.dbPath).toBe('/db');
    expect(written.pausedIntegrations).toContain('claude');
  });

  it('creates config file if it does not exist when recording paused state', async () => {
    mockExistsSync.mockReturnValue(false);
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'claude', '--yes']);

    const written = lastWrittenConfig();
    expect(written).not.toBeNull();
    expect(written.pausedIntegrations).toContain('claude');
  });
});

// ---------------------------------------------------------------------------
// agenfk pause <platform>
// ---------------------------------------------------------------------------
describe('agenfk pause <platform>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is registered as a top-level command on program', () => {
    const names = program.commands.map(c => c.name());
    expect(names).toContain('pause');
  });

  it('calls uninstall.mjs --only=claude when pausing claude', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'claude', '--yes']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('uninstall.mjs'), '--only=claude']),
      expect.anything()
    );
  });

  it('resolves alias: claude-code → claude', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'claude-code', '--yes']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--only=claude']),
      expect.anything()
    );
  });

  it('adds the platform to pausedIntegrations in config after pausing', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'cursor', '--yes']);

    const written = lastWrittenConfig();
    expect(written.pausedIntegrations).toContain('cursor');
  });

  it('does not duplicate a platform if it is already in pausedIntegrations', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['cursor'] })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'cursor', '--yes']);

    const written = lastWrittenConfig();
    const count = written.pausedIntegrations.filter((p: string) => p === 'cursor').length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// agenfk pause all
// ---------------------------------------------------------------------------
describe('agenfk pause all', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls uninstall.mjs for every supported platform', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'all', '--yes']);

    const platforms = ['claude', 'opencode', 'cursor', 'codex', 'gemini'];
    for (const p of platforms) {
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([`--only=${p}`]),
        expect.anything()
      );
    }
  });

  it('records all platforms in pausedIntegrations', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'pause', 'all', '--yes']);

    const written = lastWrittenConfig();
    expect(written.pausedIntegrations).toEqual(
      expect.arrayContaining(['claude', 'opencode', 'cursor', 'codex', 'gemini'])
    );
  });
});

// ---------------------------------------------------------------------------
// agenfk resume <platform>
// ---------------------------------------------------------------------------
describe('agenfk resume <platform>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is registered as a top-level command on program', () => {
    const names = program.commands.map(c => c.name());
    expect(names).toContain('resume');
  });

  it('calls install.mjs --only=claude when resuming a paused claude integration', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['claude'] })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'resume', 'claude', '--yes']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs'), '--only=claude']),
      expect.anything()
    );
  });

  it('removes the platform from pausedIntegrations after resuming', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['claude', 'cursor'] })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'resume', 'claude', '--yes']);

    const written = lastWrittenConfig();
    expect(written.pausedIntegrations).not.toContain('claude');
    expect(written.pausedIntegrations).toContain('cursor');
  });

  it('passes rulesScope from config to install.mjs', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['opencode'], rulesScope: 'project' })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'resume', 'opencode', '--yes']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--rules-scope=project']),
      expect.anything()
    );
  });

  it('does not call install.mjs when the platform is not currently paused', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['cursor'] })
    );

    await program.parseAsync(['node', 'agenfk', 'resume', 'claude', '--yes']);

    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs')]),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// agenfk resume all
// ---------------------------------------------------------------------------
describe('agenfk resume all', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resumes all currently paused integrations', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['claude', 'cursor'] })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'resume', 'all', '--yes']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--only=claude']),
      expect.anything()
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--only=cursor']),
      expect.anything()
    );
  });

  it('clears pausedIntegrations after resuming all', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pausedIntegrations: ['claude', 'cursor'] })
    );
    mockSpawnSync.mockReturnValue({ status: 0 });

    await program.parseAsync(['node', 'agenfk', 'resume', 'all', '--yes']);

    const written = lastWrittenConfig();
    expect(written.pausedIntegrations).toEqual([]);
  });

  it('does not call install.mjs when nothing is paused', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ pausedIntegrations: [] }));

    await program.parseAsync(['node', 'agenfk', 'resume', 'all', '--yes']);

    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs')]),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// agenfk integration — install/uninstall removed in favour of pause/resume
// ---------------------------------------------------------------------------
describe('agenfk integration — install/uninstall removed', () => {
  it('integration install subcommand no longer exists', () => {
    const integrationCmd = program.commands.find(c => c.name() === 'integration');
    expect(integrationCmd).toBeDefined();
    const subNames = integrationCmd!.commands.map(c => c.name());
    expect(subNames).not.toContain('install');
  });

  it('integration uninstall subcommand no longer exists', () => {
    const integrationCmd = program.commands.find(c => c.name() === 'integration');
    expect(integrationCmd).toBeDefined();
    const subNames = integrationCmd!.commands.map(c => c.name());
    expect(subNames).not.toContain('uninstall');
  });

  it('integration list subcommand still exists', () => {
    const integrationCmd = program.commands.find(c => c.name() === 'integration');
    expect(integrationCmd).toBeDefined();
    const subNames = integrationCmd!.commands.map(c => c.name());
    expect(subNames).toContain('list');
  });
});
