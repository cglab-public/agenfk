import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Hoist mock vars
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockCopyFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
  unlinkSync: mockUnlinkSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    copyFileSync: mockCopyFileSync,
    unlinkSync: mockUnlinkSync,
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn().mockReturnValue({ status: 0 }) },
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

const CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'config.json');
const SYSTEM_DIR = path.join(os.homedir(), '.agenfk-system');

describe('agenfk rules install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Source rule files exist, config does not
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
  });

  it('installs to project scope by default', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install']);

    // Should write CLAUDE.md to cwd/.claude/CLAUDE.md
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude/CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('installs to global scope with --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('persists rulesScope to config', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    const configWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === CONFIG_PATH
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1]);
    expect(written.rulesScope).toBe('global');
  });

  it('skips source files that do not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'rules', 'install']);

    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
    spy.mockRestore();
  });
});

describe('agenfk rules uninstall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global' }));
  });

  it('removes agenfk block from CLAUDE.md for global scope', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# My notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });

    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    const claudeWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === path.join(os.homedir(), '.claude', 'CLAUDE.md')
    );
    expect(claudeWrite).toBeDefined();
    expect(claudeWrite![1]).not.toContain('agenfk:start');
    expect(claudeWrite![1]).toContain('# My notes');
  });

  it('clears rulesScope from config when scope matches', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    const configWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === CONFIG_PATH
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1]);
    expect(written.rulesScope).toBeUndefined();
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
