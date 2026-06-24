/**
 * Tests for the CLI parity commands that close the gaps vs MCP tools:
 *   - pause_work     -> agenfk pause-work <id>      (POST /items/:id/pause)
 *   - resume_work    -> agenfk resume-work <id>     (POST /items/:id/resume)
 *   - update_project -> agenfk update-project <id>  (PUT  /projects/:id)
 *   - add_context    -> agenfk add-context <id>     (PUT  /items/:id, append context[])
 *   - delete_flow    -> agenfk flow delete <id>     (DELETE /flows/:id)
 *   - analyze_request-> agenfk analyze <request>    (static guidance text)
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
const mockInquirerPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => {
    cmd.setOptionValue(opt.attributeName(), undefined);
  });
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

// ---------------------------------------------------------------------------
// agenfk pause-work <id>
// ---------------------------------------------------------------------------
describe('agenfk pause-work <id>', () => {
  it('is registered as a top-level command', () => {
    expect(program.commands.map(c => c.name())).toContain('pause-work');
  });

  it('POSTs to /items/:id/pause with summary and resume instructions', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'snap-1', status: 'IN_PROGRESS' } });

    await program.parseAsync([
      'node', 'agenfk', 'pause-work', 'item-1',
      '--summary', 'halfway through',
      '--resume-instructions', 'pick up at step 2',
    ]);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items/item-1/pause`,
      expect.objectContaining({
        summary: 'halfway through',
        resumeInstructions: 'pick up at step 2',
      }),
    );
  });

  it('forwards --files as filesModified array and --git-diff', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'snap-1', status: 'REVIEW' } });

    await program.parseAsync([
      'node', 'agenfk', 'pause-work', 'item-1',
      '--summary', 's',
      '--resume-instructions', 'r',
      '--files', 'a.ts,b.ts',
      '--git-diff', 'diff --git a b',
    ]);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items/item-1/pause`,
      expect.objectContaining({
        filesModified: ['a.ts', 'b.ts'],
        gitDiff: 'diff --git a b',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// agenfk resume-work <id>
// ---------------------------------------------------------------------------
describe('agenfk resume-work <id>', () => {
  it('is registered as a top-level command', () => {
    expect(program.commands.map(c => c.name())).toContain('resume-work');
  });

  it('POSTs to /items/:id/resume', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { snapshot: { status: 'IN_PROGRESS' }, item: { id: 'item-1' } },
    });

    await program.parseAsync(['node', 'agenfk', 'resume-work', 'item-1']);

    expect(mockedAxios.post).toHaveBeenCalledWith(`${API}/items/item-1/resume`);
  });
});

// ---------------------------------------------------------------------------
// agenfk update-project <id>
// ---------------------------------------------------------------------------
describe('agenfk update-project <id>', () => {
  it('is registered as a top-level command', () => {
    expect(program.commands.map(c => c.name())).toContain('update-project');
  });

  it('PUTs only the fields that were provided', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: 'proj-1', name: 'Renamed' } });

    await program.parseAsync([
      'node', 'agenfk', 'update-project', 'proj-1',
      '--name', 'Renamed',
      '--verify-command', 'npm test',
    ]);

    expect(mockedAxios.put).toHaveBeenCalledWith(
      `${API}/projects/proj-1`,
      { name: 'Renamed', verifyCommand: 'npm test' },
    );
    const payload = mockedAxios.put.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('description');
  });
});

// ---------------------------------------------------------------------------
// agenfk add-context <id>
// ---------------------------------------------------------------------------
describe('agenfk add-context <id>', () => {
  it('is registered as a top-level command', () => {
    expect(program.commands.map(c => c.name())).toContain('add-context');
  });

  it('appends a context item to the existing context array and PUTs it', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { id: 'item-1', context: [{ id: 'c0', path: 'old.md' }] },
    });
    mockedAxios.put.mockResolvedValue({ data: {} });

    await program.parseAsync([
      'node', 'agenfk', 'add-context', 'item-1',
      '--path', 'docs/spec.md',
      '--description', 'the spec',
    ]);

    expect(mockedAxios.get).toHaveBeenCalledWith(`${API}/items/item-1`);
    const [, body] = mockedAxios.put.mock.calls[0];
    const ctx = (body as any).context;
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toMatchObject({ path: 'old.md' });
    expect(ctx[1]).toMatchObject({ path: 'docs/spec.md', description: 'the spec' });
    expect(ctx[1].id).toBeTruthy();
  });

  it('handles an item that has no existing context array', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: 'item-2' } });
    mockedAxios.put.mockResolvedValue({ data: {} });

    await program.parseAsync([
      'node', 'agenfk', 'add-context', 'item-2', '--path', 'a.ts',
    ]);

    const [, body] = mockedAxios.put.mock.calls[0];
    expect((body as any).context).toHaveLength(1);
    expect((body as any).context[0].path).toBe('a.ts');
  });
});

// ---------------------------------------------------------------------------
// agenfk flow delete <id>
// ---------------------------------------------------------------------------
describe('agenfk flow delete <id>', () => {
  it('flow delete subcommand is registered', () => {
    const flowCmd = program.commands.find(c => c.name() === 'flow');
    expect(flowCmd).toBeDefined();
    expect(flowCmd!.commands.map(c => c.name())).toContain('delete');
  });

  it('DELETEs /flows/:id', async () => {
    mockedAxios.delete.mockResolvedValue({ status: 204 });

    await program.parseAsync(['node', 'agenfk', 'flow', 'delete', 'flow-1', '--yes']);

    expect(mockedAxios.delete).toHaveBeenCalledWith(`${API}/flows/flow-1`);
  });
});

// ---------------------------------------------------------------------------
// agenfk analyze <request>
// ---------------------------------------------------------------------------
describe('agenfk analyze <request>', () => {
  it('is registered as a top-level command', () => {
    expect(program.commands.map(c => c.name())).toContain('analyze');
  });

  it('prints decomposition guidance and does not call the API', async () => {
    await program.parseAsync(['node', 'agenfk', 'analyze', 'add a login page']);

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toMatch(/add a login page/);
    expect(printed).toMatch(/STORY|EPIC|TASK/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
