/**
 * `agenfk update <id> --parent` — re-parenting from the CLI.
 *
 * `agenfk create` has always taken -p/--parent, but `update` had no equivalent,
 * so once an item existed its place in the tree was fixed from the CLI. This
 * surfaced while grouping two BUGs under a STORY: neither could be made a child,
 * so the link had to live in prose and the PR sizing shadow-check disagreed with
 * the declared counts.
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
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

// Full-length ids so the short-id resolution path is skipped unless a test
// deliberately exercises it.
const ITEM = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';

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

describe('agenfk update <id> --parent', () => {
  it('exposes a --parent option on update', () => {
    const update = program.commands.find(c => c.name() === 'update');
    expect(update).toBeDefined();
    const flags = (update as any).options.map((o: any) => o.long);
    expect(flags).toContain('--parent');
  });

  it('PUTs the parentId', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: PARENT } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', PARENT]);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ parentId: PARENT }),
    );
  });

  it("sends null for --parent none, to detach to top level", async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: null } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', 'none']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ parentId: null }),
    );
  });

  it('treats "null" and "root" as detach too', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: null } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', 'null']);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ parentId: null }));

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', 'root']);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(`${API}/items/${ITEM}`, expect.objectContaining({ parentId: null }));
  });

  it('does not send parentId at all when --parent is omitted', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'New', type: 'BUG', status: 'TODO' } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New']);

    const body = mockedAxios.put.mock.calls[0][1] as any;
    expect(body).not.toHaveProperty('parentId');
  });

  it('resolves a short parent id', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: PARENT, title: 'Parent' }] });
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: PARENT } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', '22222222']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ parentId: PARENT }),
    );
  });

  it('refuses an ambiguous short parent id without sending anything', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: PARENT }, { id: '22222222-dead-beef-0000-000000000000' }] });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', '2222']);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ambiguous parent ID'));
  });

  it('refuses an unknown short parent id without sending anything', async () => {
    mockedAxios.get.mockResolvedValue({ data: [] });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', 'nope']);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it("surfaces the server's refusal reason", async () => {
    mockedAxios.put.mockRejectedValue({
      response: { data: { error: 'Cannot re-parent an item under one of its own descendants — that would create a cycle.' } },
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', PARENT]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('cycle'),
    );
  });

  it('reports the resulting parent', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: PARENT } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', PARENT]);

    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain(PARENT);
  });

  it('reports detachment in words rather than printing an empty parent', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: null } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', 'none']);

    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toMatch(/top level/i);
  });

  // A prefix unique inside the user's project must not be called ambiguous just
  // because an unrelated project they cannot see shares it.
  it('scopes short-parent-id matching to the item\'s own project', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith(`/items/${ITEM}`)) {
        return Promise.resolve({ data: { id: ITEM, projectId: 'proj-a' } });
      }
      return Promise.resolve({
        data: [
          { id: PARENT, projectId: 'proj-a' },
          { id: '22222222-dead-beef-0000-000000000000', projectId: 'proj-b' },
        ],
      });
    });
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'T', type: 'BUG', status: 'TODO', parentId: PARENT } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', '2222']);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/items/${ITEM}`,
      expect.objectContaining({ parentId: PARENT }),
    );
  });

  it('still reports ambiguity when the collision is inside the same project', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith(`/items/${ITEM}`)) {
        return Promise.resolve({ data: { id: ITEM, projectId: 'proj-a' } });
      }
      return Promise.resolve({
        data: [
          { id: PARENT, projectId: 'proj-a' },
          { id: '22222222-dead-beef-0000-000000000000', projectId: 'proj-a' },
        ],
      });
    });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--parent', '2222']);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ambiguous parent ID'));
  });
});
