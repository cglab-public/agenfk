import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Hoist mock vars
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockCopyFileSync, mockUnlinkSync, mockReaddirSync, mockRmdirSync, mockExecSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReaddirSync: vi.fn().mockReturnValue([]),
  mockRmdirSync: vi.fn(),
  mockExecSync: vi.fn().mockReturnValue('/fake/project/root'),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
  unlinkSync: mockUnlinkSync,
  readdirSync: mockReaddirSync,
  rmdirSync: mockRmdirSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    copyFileSync: mockCopyFileSync,
    unlinkSync: mockUnlinkSync,
    readdirSync: mockReaddirSync,
    rmdirSync: mockRmdirSync,
  },
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
  default: { execSync: mockExecSync, spawn: vi.fn(), spawnSync: vi.fn().mockReturnValue({ status: 0 }) },
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
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));

import { program } from '../index';

const CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'config.json');

/** Reset Commander option state to prevent test pollution across suites */
function resetCommanderGlobalOption(): void {
  const rulesCmd = program.commands.find((c: any) => c.name() === 'skills');
  const installCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'install');
  const uninstallCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'uninstall');
  if (installCmd) (installCmd as any)._optionValues = {};
  if (uninstallCmd) (uninstallCmd as any)._optionValues = {};
}

const FAKE_GIT_ROOT = '/fake/project/root';
const SYSTEM_DIR = path.join(os.homedir(), '.agenfk-system');

describe('agenfk rules install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT);
    // Source rule files exist, config does not
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
    mockReaddirSync.mockReturnValue([]);
  });

  it('installs to global scope by default (no flag)', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('installs to global scope with --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--global']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('installs to project scope with --project', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(FAKE_GIT_ROOT, '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('project scope uses git root, not process.cwd()', async () => {
    mockExecSync.mockReturnValue('/some/git/root');

    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join('/some/git/root', '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
    // Must NOT install to process.cwd()
    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      path.join(process.cwd(), '.claude', 'CLAUDE.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('persists rulesScope=global to config by default', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const configWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === CONFIG_PATH
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1]);
    expect(written.rulesScope).toBe('global');
  });

  it('persists rulesScope=project to config with --project', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    const configWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === CONFIG_PATH
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1]);
    expect(written.rulesScope).toBe('project');
  });

  it('skips source files that do not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

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
    resetCommanderGlobalOption();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global' }));
    mockReaddirSync.mockReturnValue([]);
  });

  it('uninstalls from global scope by default (no flag)', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# My notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall']);

    const claudeWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === path.join(os.homedir(), '.claude', 'CLAUDE.md')
    );
    expect(claudeWrite).toBeDefined();
    expect(claudeWrite![1]).not.toContain('agenfk:start');
  });

  it('removes agenfk block from CLAUDE.md for global scope', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# My notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    const claudeWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === path.join(os.homedir(), '.claude', 'CLAUDE.md')
    );
    expect(claudeWrite).toBeDefined();
    expect(claudeWrite![1]).not.toContain('agenfk:start');
    expect(claudeWrite![1]).toContain('# My notes');
  });

  it('clears rulesScope from config when scope matches', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    const configWrite = mockWriteFileSync.mock.calls.find(
      (c: any[]) => c[0] === CONFIG_PATH
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1]);
    expect(written.rulesScope).toBeUndefined();
  });
});

describe('agenfk rules install — commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT);
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      return [];
    });
  });

  it('installs skills to Universal (.agents) only in project (--project)', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    // Universal (.agents) is the single install target — all platforms read from there
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(FAKE_GIT_ROOT, '.agents', 'skills', 'agenfk-flow', 'SKILL.md'),
      expect.any(String)
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(FAKE_GIT_ROOT, '.agents', 'skills', 'agenfk-close', 'SKILL.md'),
      expect.any(String)
    );
  });

  it('installs skills to Universal (.agents) only globally (default)', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    // Universal (.agents) is the single install target — all platforms read from there
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-flow', 'SKILL.md'),
      expect.any(String)
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-close', 'SKILL.md'),
      expect.any(String)
    );
  });
});

describe('agenfk rules uninstall — skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      return [];
    });
  });

  it('removes Universal (.agents) skill on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('removes Universal (.agents) skill on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    // .agents/skills is the universal path (used by OpenCode, Cursor, Gemini, Codex)
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('removes Universal (.agents) skills on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    // Only Universal (.agents) is in COMMAND_SKILL_PLATFORMS
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-flow', 'SKILL.md')
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.agents', 'skills', 'agenfk-close', 'SKILL.md')
    );
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
    await program.parseAsync(['node', 'agenfk', 'skills', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('global'));
    spy.mockRestore();
  });

  it('reports "project" when config has rulesScope=project', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'project' }));

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'skills', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('project'));
    spy.mockRestore();
  });

  it('reports "not configured" when no rulesScope is set', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');

    const spy = vi.spyOn(console, 'log');
    await program.parseAsync(['node', 'agenfk', 'skills', 'status']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    spy.mockRestore();
  });
});
