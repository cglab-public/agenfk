/**
 * Behavioral tests for `agenfk skills install` — platform-specific output.
 *
 * Verifies the actual files and content written by the install command:
 * - Gemini TOML slash commands generated with correct format
 * - OpenCode flat .md slash commands installed
 * - `name` frontmatter field injected into skill files that lack it
 * - `name` field NOT duplicated if already present in frontmatter
 * - Gemini and OpenCode files removed on uninstall
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockCopyFileSync, mockUnlinkSync, mockReaddirSync, mockRmdirSync, mockExecSync } =
  vi.hoisted(() => ({
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
}));

import { program } from '../index';

const FAKE_GIT_ROOT = '/fake/project/root';
const SYSTEM_DIR = path.join(os.homedir(), '.agenfk-system');

function resetSkillsOptions() {
  const rulesCmd = program.commands.find((c: any) => c.name() === 'skills');
  const installCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'install');
  const uninstallCmd = (rulesCmd as any)?.commands?.find((c: any) => c.name() === 'uninstall');
  if (installCmd) (installCmd as any)._optionValues = {};
  if (uninstallCmd) (uninstallCmd as any)._optionValues = {};
}

function setupInstallBase() {
  mockExecSync.mockReturnValue(FAKE_GIT_ROOT);
  mockExistsSync.mockImplementation((p: string) =>
    p.includes('.agenfk-system') && !p.includes('config.json')
  );
  mockReadFileSync.mockReturnValue('<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->');
  mockReaddirSync.mockReturnValue([]);
}

// ── Gemini TOML generation ───────────────────────────────────────────────────

describe('agenfk skills install — Gemini TOML generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillsOptions();
    setupInstallBase();
    // Two command source files
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      return [];
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agenfk-flow.md')) {
        return '---\ndescription: Manage flows\n---\nFlow skill content';
      }
      if (typeof p === 'string' && p.endsWith('agenfk-close.md')) {
        return '---\ndescription: Close a task\n---\nClose skill content';
      }
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });
  });

  it('writes .toml files to ~/.gemini/commands/ on global install', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const tomlWrites = mockWriteFileSync.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('.gemini') && c[0].endsWith('.toml')
    );
    expect(tomlWrites.length).toBeGreaterThan(0);
    expect(tomlWrites.some((c: any[]) => c[0].includes('agenfk-flow.toml'))).toBe(true);
    expect(tomlWrites.some((c: any[]) => c[0].includes('agenfk-close.toml'))).toBe(true);
  });

  it('writes .toml files to project .gemini/commands/ on --project install', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    const tomlWrites = mockWriteFileSync.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' &&
      c[0].includes(FAKE_GIT_ROOT) &&
      c[0].includes('.gemini') &&
      c[0].endsWith('.toml')
    );
    expect(tomlWrites.length).toBeGreaterThan(0);
  });

  it('TOML content has description field extracted from frontmatter', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const flowToml = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow.toml')
    );
    expect(flowToml).toBeDefined();
    expect(flowToml![1]).toContain('description = "Manage flows"');
  });

  it('TOML content wraps the full .md content in a prompt block', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const flowToml = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow.toml')
    );
    expect(flowToml).toBeDefined();
    expect(flowToml![1]).toContain('prompt = """');
    expect(flowToml![1]).toContain('Flow skill content');
  });

  it('TOML description falls back to skill name when frontmatter has no description', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agenfk-flow.md')) {
        return 'No frontmatter here, just plain text';
      }
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const flowToml = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow.toml')
    );
    expect(flowToml).toBeDefined();
    expect(flowToml![1]).toContain('description = "agenfk-flow"');
  });
});

// ── OpenCode flat .md commands ───────────────────────────────────────────────

describe('agenfk skills install — OpenCode flat .md commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillsOptions();
    setupInstallBase();
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) {
        return ['agenfk-flow.md', 'agenfk-close.md'];
      }
      return [];
    });
    mockReadFileSync.mockReturnValue('---\ndescription: A skill\n---\ncontent');
  });

  it('copies .md files to ~/.config/opencode/commands/ on global install', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('agenfk-flow.md'),
      path.join(os.homedir(), '.config', 'opencode', 'commands', 'agenfk-flow.md')
    );
  });

  it('copies .md files to project .opencode/commands/ on --project install', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'install', '--project']);

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('agenfk-flow.md'),
      path.join(FAKE_GIT_ROOT, '.opencode', 'commands', 'agenfk-flow.md')
    );
  });
});

// ── `name` frontmatter injection ─────────────────────────────────────────────

describe('agenfk skills install — name frontmatter injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillsOptions();
    setupInstallBase();
    mockReaddirSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('commands')) return ['agenfk-flow.md'];
      return [];
    });
  });

  it('injects name field when frontmatter has no name', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agenfk-flow.md')) {
        return '---\ndescription: Manage flows\n---\nContent here';
      }
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const skillWrite = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow') && c[0].includes('SKILL.md')
    );
    expect(skillWrite).toBeDefined();
    expect(skillWrite![1]).toContain('name: agenfk-flow');
  });

  it('does NOT inject duplicate name when frontmatter already has a name field', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agenfk-flow.md')) {
        return '---\nname: agenfk-flow\ndescription: Manage flows\n---\nContent';
      }
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const skillWrite = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow') && c[0].includes('SKILL.md')
    );
    expect(skillWrite).toBeDefined();
    // Only one occurrence of `name:` in the frontmatter
    const nameMatches = (skillWrite![1] as string).match(/^name:/gm);
    expect(nameMatches?.length).toBe(1);
  });

  it('does NOT inject name into files that have no frontmatter at all', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agenfk-flow.md')) {
        return 'No frontmatter, just plain text content.';
      }
      return '<!-- agenfk:start -->\ncontent\n<!-- agenfk:end -->';
    });

    await program.parseAsync(['node', 'agenfk', 'skills', 'install']);

    const skillWrite = mockWriteFileSync.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('agenfk-flow') && c[0].includes('SKILL.md')
    );
    expect(skillWrite).toBeDefined();
    // Content should be written as-is, no name injection
    expect(skillWrite![1]).not.toContain('name: agenfk-flow');
  });
});

// ── Gemini uninstall ─────────────────────────────────────────────────────────

describe('agenfk skills uninstall — Gemini TOML cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillsOptions();
    mockExecSync.mockReturnValue(FAKE_GIT_ROOT);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('config.json')) return JSON.stringify({ rulesScope: 'global' });
      return '# notes\n\n<!-- agenfk:start -->\nrules\n<!-- agenfk:end -->\n';
    });
    mockReaddirSync.mockImplementation((p: string) => {
      const dir = typeof p === 'string' ? p : '';
      if (dir.includes('.gemini') && dir.includes('commands')) {
        return ['agenfk-flow.toml', 'agenfk-close.toml', 'other-tool.toml'];
      }
      if (dir.includes('commands')) return ['agenfk-flow.md', 'agenfk-close.md'];
      return [];
    });
  });

  it('removes agenfk*.toml files from ~/.gemini/commands/ on global uninstall', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    const tomlRemovals = mockUnlinkSync.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].endsWith('.toml')
    );
    expect(tomlRemovals.length).toBeGreaterThan(0);
    expect(
      tomlRemovals.some((c: any[]) => c[0].includes('agenfk-flow.toml'))
    ).toBe(true);
  });

  it('does NOT remove non-agenfk .toml files from ~/.gemini/commands/', async () => {
    await program.parseAsync(['node', 'agenfk', 'skills', 'uninstall', '--global']);

    const removedPaths = mockUnlinkSync.mock.calls.map((c: any[]) => c[0] as string);
    expect(removedPaths.some((p) => p.endsWith('other-tool.toml'))).toBe(false);
  });
});
