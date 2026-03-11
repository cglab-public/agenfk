import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Hoist mock vars
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockCopyFileSync, mockUnlinkSync, mockReaddirSync, mockRmdirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReaddirSync: vi.fn().mockReturnValue([]),
  mockRmdirSync: vi.fn(),
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

/** Reset Commander --global option state to prevent test pollution across suites */
function resetCommanderGlobalOption(): void {
  const rulesCmd = program.commands.find((c: any) => c.name() === 'rules');
  const installCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'install');
  const uninstallCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'uninstall');
  if (installCmd) (installCmd as any)._optionValues = {};
  if (uninstallCmd) (uninstallCmd as any)._optionValues = {};
}
const SYSTEM_DIR = path.join(os.homedir(), '.agenfk-system');

describe('agenfk rules install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    // Source rule files exist, config does not
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
    mockReaddirSync.mockReturnValue([]);
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
    resetCommanderGlobalOption();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rulesScope: 'global' }));
    mockReaddirSync.mockReturnValue([]);
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

describe('agenfk rules install — skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
    mockReaddirSync.mockReturnValue([]);
  });

  it('copies Claude Code agenfk-flow skill to global path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'claude-code', 'agenfk-flow', 'SKILL.md')),
      path.join(os.homedir(), '.claude', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('copies Claude Code agenfk-flow skill to project path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'claude-code', 'agenfk-flow', 'SKILL.md')),
      expect.stringContaining(path.join('.claude', 'skills', 'agenfk-flow', 'SKILL.md'))
    );
  });

  it('copies OpenCode agenfk-flow skill to global path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'opencode', 'agenfk-flow', 'SKILL.md')),
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('copies Cursor agenfk-flow skill to global path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'cursor', 'agenfk-flow.mdc')),
      path.join(os.homedir(), '.cursor', 'skills', 'agenfk-flow.mdc')
    );
  });

  it('copies Codex agenfk-flow skill to global path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'codex', 'agenfk-flow.md')),
      path.join(os.homedir(), '.codex', 'skills', 'agenfk-flow.md')
    );
  });

  it('copies Gemini agenfk-flow skill to global path', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('skills', 'gemini', 'agenfk-flow.md')),
      path.join(os.homedir(), '.gemini', 'skills', 'agenfk-flow.md')
    );
  });

  it('removes project skill files when switching to global scope', async () => {
    // Project skill files exist
    mockExistsSync.mockImplementation((p: string) => true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return '{}';
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });

    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    // Project Claude Code skill should be deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join(process.cwd(), '.claude', 'skills', 'agenfk-flow', 'SKILL.md'))
    );
  });
});

describe('agenfk rules install — commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('.agenfk-system') && !p.includes('config.json')
    );
    mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
    // Simulate two command files in system commands dir
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      return [];
    });
  });

  // Project-scope tests run first to avoid Commander option bleed from --global tests
  it('installs all platform commands as skills/name/SKILL.md in project', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install']);

    for (const skillsDir of [
      path.join(process.cwd(), '.claude', 'skills'),
      path.join(process.cwd(), '.opencode', 'skills'),
      path.join(process.cwd(), '.cursor', 'skills'),
      path.join(process.cwd(), '.codex', 'skills'),
      path.join(process.cwd(), '.gemini', 'skills'),
    ]) {
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agenfk-flow.md'),
        path.join(skillsDir, 'agenfk-flow', 'SKILL.md')
      );
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agenfk-close.md'),
        path.join(skillsDir, 'agenfk-close', 'SKILL.md')
      );
    }
  });

  it('installs all platform commands as skills/name/SKILL.md globally', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'install', '--global']);

    for (const skillsDir of [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.config', 'opencode', 'skills'),
      path.join(os.homedir(), '.cursor', 'skills'),
      path.join(os.homedir(), '.codex', 'skills'),
      path.join(os.homedir(), '.gemini', 'skills'),
    ]) {
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agenfk-flow.md'),
        path.join(skillsDir, 'agenfk-flow', 'SKILL.md')
      );
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agenfk-close.md'),
        path.join(skillsDir, 'agenfk-close', 'SKILL.md')
      );
    }
  });
});

describe('agenfk rules uninstall — skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommanderGlobalOption();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      // For skill dirs (checking what to delete), return empty
      return [];
    });
  });

  it('removes global Claude Code skill on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.claude', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('removes global OpenCode skill on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk-flow', 'SKILL.md')
    );
  });

  it('removes global Cursor skill on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.cursor', 'skills', 'agenfk-flow.mdc')
    );
  });

  it('removes command skills from all platforms on uninstall --global', async () => {
    await program.parseAsync(['node', 'agenfk', 'rules', 'uninstall', '--global']);

    for (const skillsDir of [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.config', 'opencode', 'skills'),
      path.join(os.homedir(), '.cursor', 'skills'),
      path.join(os.homedir(), '.codex', 'skills'),
      path.join(os.homedir(), '.gemini', 'skills'),
    ]) {
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        path.join(skillsDir, 'agenfk-flow', 'SKILL.md')
      );
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        path.join(skillsDir, 'agenfk-close', 'SKILL.md')
      );
    }
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
