/**
 * `agenfk branch set <itemId> [branchName]` — linking an already-created branch.
 *
 * `agenfk branch create` both creates the branch AND records it on the item, so
 * an agent that branched by hand (`git checkout -b …`) leaves the item's
 * `branchName` empty. Everything downstream then misfires: `branch push` and
 * `branch status` claim no branch is linked, and `resume-work` cannot offer the
 * checkout hint. `branch set` closes that gap by recording an existing branch —
 * by default whichever one is currently checked out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('axios');
vi.mock('child_process', () => {
  const execSync = vi.fn();
  const spawn = vi.fn();
  const spawnSync = vi.fn();
  return { execSync, spawn, spawnSync, default: { execSync, spawn, spawnSync } };
});
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';
import { execSync } from 'child_process';

const mockedAxios = vi.mocked(axios, true);
const mockedExecSync = vi.mocked(execSync);
const API = 'http://localhost:3000';

const ITEM = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';

/** Drive git: `HEAD` resolves to `current`, and only `known` branches verify. */
function gitWith({ current, known }: { current: string; known: string[] }) {
  mockedExecSync.mockImplementation(((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return `${current}\n`;
    const verify = cmd.match(/rev-parse --verify (?:--quiet )?(\S+)/);
    if (verify) {
      const ref = verify[1];
      if (!known.includes(ref)) throw new Error(`fatal: Needed a single revision: ${ref}`);
      return 'deadbeef\n';
    }
    return '';
  }) as any);
}

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

describe('agenfk branch set', () => {
  it('is registered as a subcommand of `branch`', () => {
    const branch = program.commands.find(c => c.name() === 'branch');
    expect(branch).toBeDefined();
    const names = (branch as any).commands.map((c: any) => c.name());
    expect(names).toContain('set');
  });

  it('links the currently checked-out branch when no name is given', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    mockedAxios.put.mockResolvedValue({ data: {} });
    gitWith({ current: 'feature/hand-rolled', known: ['feature/hand-rolled'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM]);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      { branchName: 'feature/hand-rolled' },
    );
  });

  it('links the branch named on the command line instead of HEAD', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    mockedAxios.put.mockResolvedValue({ data: {} });
    gitWith({ current: 'main', known: ['main', 'fix/CGLAB-99_thing'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM, 'fix/CGLAB-99_thing']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      { branchName: 'fix/CGLAB-99_thing' },
    );
  });

  it('accepts any branch name — no feature/ or fix/ prefix is imposed', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG' } });
    mockedAxios.put.mockResolvedValue({ data: {} });
    gitWith({ current: 'main', known: ['main', 'daniel/experiment'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM, 'daniel/experiment']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      { branchName: 'daniel/experiment' },
    );
  });

  it('never creates or switches branches — it only records one', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    mockedAxios.put.mockResolvedValue({ data: {} });
    gitWith({ current: 'feature/hand-rolled', known: ['feature/hand-rolled'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM]);

    const gitCommands = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(gitCommands.some(c => /checkout|switch|branch -[mM]/.test(c))).toBe(false);
  });

  it('refuses a child item, pointing at the parent', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', parentId: PARENT } });
    gitWith({ current: 'feature/hand-rolled', known: ['feature/hand-rolled'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM]);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('top-level items only'));
  });

  it('refuses a branch that does not exist locally', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    gitWith({ current: 'main', known: ['main'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM, 'feature/typo']);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('feature/typo'));
  });

  it('refuses a detached HEAD rather than linking the literal "HEAD"', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    gitWith({ current: 'HEAD', known: ['HEAD', 'main'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM]);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('detached HEAD'));
  });

  it('surfaces the server refusal instead of claiming success', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });
    mockedAxios.put.mockRejectedValue({ response: { data: { error: 'Item not found' } } });
    gitWith({ current: 'feature/hand-rolled', known: ['feature/hand-rolled'] });

    await program.parseAsync(['node', 'agenfk', 'branch', 'set', ITEM]);

    expect(errorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Item not found'));
  });
});

describe('unlinked-branch guidance', () => {
  it("`branch push` offers `branch set` for a branch that already exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });

    await program.parseAsync(['node', 'agenfk', 'branch', 'push', ITEM]);

    const said = errorSpy.mock.calls.flat().join(' ');
    expect(said).toContain('branch set');
  });

  it("`branch status` offers `branch set` for a branch that already exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK' } });

    await program.parseAsync(['node', 'agenfk', 'branch', 'status', ITEM]);

    const said = logSpy.mock.calls.flat().join(' ');
    expect(said).toContain('branch set');
  });
});
