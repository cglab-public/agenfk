/**
 * Follow-up to the comment/add-context/log-test fix: pause-work, worktree,
 * pr, review, branch and tokens sent their <itemId> straight to routes that
 * match the EXACT id, so the 8-char id every listing prints answered
 * "Item not found" (or, for `tokens --item`, silently returned nothing).
 * They now resolve the id the way `get` does: a full id is taken as-is, a
 * unique prefix resolves, an ambiguous or unknown prefix is refused with
 * exit 1 - the ambiguous one listing its candidates - before any request
 * that names the item.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
  execFileSync: vi.fn().mockReturnValue(''),
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
  default: {
    execSync: vi.fn().mockReturnValue(''),
    execFileSync: vi.fn().mockReturnValue(''),
    spawn: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
  },
}));
// `review record` reads ~/.agenfk/verify-token; everything else is the real fs.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const isToken = (p: unknown) => String(p).endsWith('verify-token');
  const existsSync = (p: any) => isToken(p) || real.existsSync(p);
  const readFileSync = (p: any, ...rest: any[]) => (isToken(p) ? 'test-token' : (real.readFileSync as any)(p, ...rest));
  return { ...real, existsSync, readFileSync, default: { ...real, existsSync, readFileSync } };
});

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

const FULL = 'd1ff2cf4-6b1e-4c3a-9a51-0e7f6c2b8d10';
const TWIN_A = '2cab541e-d262-4241-a0fa-104b894ffb98';
const TWIN_B = '2cab541f-0000-0000-0000-000000000000';
const ITEMS = [
  { id: FULL, title: 'The one meant' },
  { id: TWIN_A, title: 'First twin' },
  { id: TWIN_B, title: 'Second twin' },
];

/** process.exit stops the action here, as it would for real. */
class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${code}`); }
}

function resetCommanderOptions(cmd: any) {
  ((cmd as any).options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url === `${API}/items`) return { data: ITEMS };
    if (url === `${API}/token-events`) return { data: [] };
    const id = url.slice(`${API}/items/`.length).split(/[/?]/)[0];
    if (!ITEMS.some(i => i.id === id)) {
      throw Object.assign(new Error('Request failed with status code 404'), { response: { data: { error: 'Item not found' } } });
    }
    if (url.endsWith('/worktree')) return { data: { path: '/tmp/wt', branchName: 'b', exists: true } };
    if (url.endsWith('/review-brief')) return { data: { text: 'brief' } };
    return { data: { id, title: 'T', type: 'TASK', branchName: 'feature/x', prNumber: 7 } };
  });
  mockedAxios.post.mockResolvedValue({ data: { id: 'snap', status: 'IN_PROGRESS', created: true, path: '/tmp/wt', branchName: 'b', findings: [] } });
  mockedAxios.put.mockResolvedValue({ data: {} });
  mockedAxios.delete.mockResolvedValue({ data: { removed: true } });
});

async function run(argv: string[]) {
  await program.parseAsync(['node', 'agenfk', ...argv]).catch((e) => {
    if (!(e instanceof Exit)) throw e;
  });
}

/** Every URL the command sent, in order, across all verbs. */
function urls(): string[] {
  return [mockedAxios.get, mockedAxios.post, mockedAxios.put, mockedAxios.delete]
    .flatMap(m => m.mock.calls)
    .map(c => String(c[0]));
}

/** The requests that name one item. */
function itemUrls(): string[] {
  return urls().filter(u => u.startsWith(`${API}/items/`));
}

const commands: Array<[string, (id: string) => string[]]> = [
  ['pause-work', id => ['pause-work', id, '--summary', 's', '--resume-instructions', 'r']],
  ['worktree create', id => ['worktree', 'create', id]],
  ['worktree status', id => ['worktree', 'status', id]],
  ['worktree remove', id => ['worktree', 'remove', id]],
  ['branch create', id => ['branch', 'create', id, '--name', 'feature/x']],
  ['branch push', id => ['branch', 'push', id]],
  ['branch status', id => ['branch', 'status', id]],
  ['branch link', id => ['branch', 'link', id, 'feature/x']],
  ['pr create', id => ['pr', 'create', id, '--model', 'm', '--harness', 'claude-code', '--no-detect-model']],
  ['pr status', id => ['pr', 'status', id]],
  ['pr check', id => ['pr', 'check', id]],
  ['review record', id => ['review', 'record', id, '--transcript', '/tmp/t.jsonl', '--findings', '[]']],
  ['review brief', id => ['review', 'brief', id]],
];

describe.each(commands)('agenfk %s <itemId>', (_name, argv) => {
  it('resolves a unique 8-char prefix to the full id', async () => {
    await run(argv(FULL.slice(0, 8)));

    expect(itemUrls().length).toBeGreaterThan(0);
    for (const u of itemUrls()) expect(u.startsWith(`${API}/items/${FULL}`)).toBe(true);
  });

  it('takes a full id as-is, without listing the items', async () => {
    await run(argv(FULL));

    expect(mockedAxios.get).not.toHaveBeenCalledWith(`${API}/items`);
    expect(itemUrls().length).toBeGreaterThan(0);
  });

  it('refuses an ambiguous prefix with the candidates, before naming any item', async () => {
    await run(argv('2cab541'));

    expect(itemUrls()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errorSpy.mock.calls.flat().join(' ');
    expect(err).toContain('Ambiguous ID 2cab541');
    expect(err).toContain(TWIN_A);
    expect(err).toContain(TWIN_B);
  });

  it('refuses a prefix nothing starts with', async () => {
    await run(argv('deadbeef'));

    expect(itemUrls()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('No item found starting with deadbeef');
  });
});

describe('agenfk tokens --item <id>', () => {
  const tokenParams = () =>
    mockedAxios.get.mock.calls.filter(c => c[0] === `${API}/token-events`).map(c => (c[1] as any)?.params);

  it('resolves a unique 8-char prefix to the full id', async () => {
    await run(['tokens', '--item', FULL.slice(0, 8)]);

    expect(tokenParams()).toEqual([{ itemId: FULL }]);
  });

  it('takes a full id as-is, without listing the items', async () => {
    await run(['tokens', '--item', FULL]);

    expect(mockedAxios.get).not.toHaveBeenCalledWith(`${API}/items`);
    expect(tokenParams()).toEqual([{ itemId: FULL }]);
  });

  it('refuses an ambiguous prefix with the candidates, before querying', async () => {
    await run(['tokens', '--item', '2cab541']);

    expect(tokenParams()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errorSpy.mock.calls.flat().join(' ');
    expect(err).toContain('Ambiguous ID 2cab541');
    expect(err).toContain(TWIN_A);
  });

  it('refuses a prefix nothing starts with', async () => {
    await run(['tokens', '--item', 'deadbeef']);

    expect(tokenParams()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('leaves the query unfiltered by item when --item is absent', async () => {
    await run(['tokens']);

    expect(mockedAxios.get).not.toHaveBeenCalledWith(`${API}/items`);
    expect(tokenParams()).toEqual([{}]);
  });
});
