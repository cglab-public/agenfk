/**
 * The MCP opt-in must be reachable from the documented entry point:
 *   - `agenfk integration install <p> --with-mcp` → CLI forwards the flag to install.mjs
 * and likewise `--no-mcp` to force-disable.
 * (The bin/agenfk.js forwarding is asserted in install-cli-only-default.test.ts,
 * which does not mock fs.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockSpawnSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
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
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync, writeFileSync: vi.fn(), mkdirSync: vi.fn() },
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(), spawn: vi.fn(), spawnSync: mockSpawnSync,
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: mockSpawnSync },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import { program } from '../index';

function resetCommanderOptions(cmd: any) {
  ((cmd as any).options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

describe('agenfk integration install --with-mcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
    mockSpawnSync.mockReturnValue({ status: 0 });
    resetCommanderOptions(program);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('forwards --with-mcp to install.mjs', async () => {
    await program.parseAsync(['node', 'agenfk', 'integration', 'install', 'codex', '--with-mcp', '--yes']);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('install.mjs'), '--only=codex', '--with-mcp']),
      expect.anything()
    );
  });

  it('forwards --no-mcp to install.mjs', async () => {
    await program.parseAsync(['node', 'agenfk', 'integration', 'install', 'codex', '--no-mcp', '--yes']);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--no-mcp']),
      expect.anything()
    );
  });

  it('does not forward an MCP flag when neither is given', async () => {
    await program.parseAsync(['node', 'agenfk', 'integration', 'install', 'codex', '--yes']);
    const call = mockSpawnSync.mock.calls.find(c => Array.isArray(c[1]) && c[1].some((a: string) => a.includes('install.mjs')));
    expect(call).toBeTruthy();
    expect(call![1]).not.toContain('--with-mcp');
    expect(call![1]).not.toContain('--no-mcp');
  });
});
