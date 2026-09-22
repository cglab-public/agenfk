import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  // The shared writer creates ~/.agenfk before writing into it, because the
  // settings screen is reachable on a machine where no command has ever run.
  mockMkdirSync: vi.fn(),
}));

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
/*
 * PARTIAL, and the partiality is the point.
 *
 * `agenfk config set telemetry` used to write ~/.agenfk/config.json inline in
 * the command; it now calls `setTelemetryEnabled` in @agenfk/telemetry, which
 * the settings screen's route calls too. A fully hand-written mock would stub
 * that away and leave this file asserting that the CLI called a function -
 * which is a much weaker claim than the one it makes below, that the FILE ends
 * up with the flag set and every other key still in it.
 *
 * So the real writer runs, against the mocked `fs` above. What stays stubbed is
 * only the network client and the port discovery.
 */
vi.mock('@agenfk/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agenfk/telemetry')>()),
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
  mkdirSync: mockMkdirSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
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
