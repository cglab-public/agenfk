import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist fs mock vars so they're available inside vi.mock factory
const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
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
  default: { textSync: vi.fn().mockReturnValue('AgenFK') },
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
