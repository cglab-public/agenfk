/**
 * 686fdbf6 — `agenfk update <id> --worktree <path>|none|inherit`: a card
 * chooses the tree it runs in. An agent detached a card from its epic because
 * the epic's worktree bound it and re-parenting was the only lever it found.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockRealpathSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockRealpathSync: vi.fn(),
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
  realpathSync: mockRealpathSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import * as path from 'path';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

// Full-length ids so the short-id resolution path is skipped unless a test
// deliberately exercises it.
const ITEM = '11111111-1111-1111-1111-111111111111';

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

describe('agenfk update <id> --worktree (686fdbf6)', () => {
  it('exposes a --worktree option on update', () => {
    const update = program.commands.find(c => c.name() === 'update')!;
    expect((update as any).options.map((o: any) => o.long)).toContain('--worktree');
  });

  it('sends an absolute path, resolved from where the command runs', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO' } });
    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--worktree', 'some/checkout']);
    expect(mockedAxios.put).toHaveBeenCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ worktree: path.resolve(process.cwd(), 'some/checkout') }));
  });

  it('sends an existing path as it is on disk, links resolved (git lists /private/tmp, not /tmp)', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO' } });
    mockExistsSync.mockImplementation((p: string) => p === '/tmp/wt');
    mockRealpathSync.mockImplementation((p: string) => (p === '/tmp/wt' ? '/private/tmp/wt' : p));
    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--worktree', '/tmp/wt']);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ worktree: '/private/tmp/wt' }));
  });

  it("sends 'none' for the project root, and 'inherit' to clear the choice", async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'TASK', status: 'TODO' } });
    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--worktree', 'none']);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ worktree: 'none' }));
    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--worktree', 'inherit']);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ worktree: 'inherit' }));
  });

  it('sends no worktree field when the option is left off', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'New', type: 'TASK', status: 'TODO' } });
    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New']);
    expect(mockedAxios.put.mock.calls[0][1] as any).not.toHaveProperty('worktree');
  });
});
