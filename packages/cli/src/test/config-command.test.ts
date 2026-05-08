import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
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
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
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

// Mock other modules CLI imports so they don't cause side effects
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn() },
}));
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));

import { program } from '../index';
import * as path from 'path';
import * as os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'config.json');

describe('agenfk config set telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes telemetry: true when called with "true" on existing config', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ dbPath: '/some/path' }));

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'telemetry', 'true']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining('"telemetry": true'),
      'utf8'
    );
    // Preserves existing keys
    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.dbPath).toBe('/some/path');
    expect(written.telemetry).toBe(true);
  });

  it('writes telemetry: false when called with "false"', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'telemetry', 'false']);

    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.telemetry).toBe(false);
  });

  it('creates a new config when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'telemetry', 'true']);

    expect(mockReadFileSync).not.toHaveBeenCalled();
    const written = JSON.parse(
      (mockWriteFileSync.mock.calls[0] as any[])[1] as string
    );
    expect(written.telemetry).toBe(true);
  });

  it('the config command is registered on program', () => {
    const names = program.commands.map(c => c.name());
    expect(names).toContain('config');
  });
});

describe('CLI preAction telemetry hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockReturnValue(undefined);
  });

  it('fires cli_command event with the command name on every invocation', async () => {
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'telemetry', 'true']);
    expect(mockCapture).toHaveBeenCalledWith('cli_command', expect.objectContaining({
      command: 'telemetry',
    }));
  });
});
