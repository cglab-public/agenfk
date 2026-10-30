/**
 * `agenfk gatekeeper` in a project this machine has not linked.
 *
 * Since CGLAB-625 the id lives in the git-ignored .agenfk/local.json, so every
 * fresh clone is unlinked. The command resolved the project with findProjectId
 * and, with no id, counted every project's items: a task in another repo
 * printed AUTHORIZED here, while `agenfk create` could not even run. It now
 * refuses in requireCwdProject's words, as the PreToolUse hook does, with
 * --item-id too. A linked project, and a directory in no project at all
 * (--item-id following the card, gatekeeper-leave-plan.test.ts), are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

// A task in ANOTHER project, active: what used to authorize an unlinked clone.
const ELSEWHERE = { id: 'e1e1e1e1-0000-0000-0000-000000000000', title: 'Elsewhere', type: 'TASK', status: 'MAKE', projectId: 'other' };
const HERE = { id: 'c1c1c1c1-0000-0000-0000-000000000000', title: 'Here', type: 'TASK', status: 'MAKE', projectId: 'p1' };
const FLOW = { id: 'f1', name: 'F', steps: [
  { name: 'START', order: 0, isAnchor: true }, { name: 'MAKE', order: 1, role: 'coding' },
  { name: 'CHECK', order: 2, role: 'review' }, { name: 'END', order: 3, isAnchor: true },
] };

function resetCommanderOptions(cmd: any) {
  (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let out: string[];
let exitCodes: Array<number | undefined>;
let spies: Array<{ mockRestore: () => void }>;
let cwd: string;
let tmp: string;

beforeEach(() => {
  resetCommanderOptions(program);
  out = [];
  exitCodes = [];
  // eslint-disable-next-line no-control-regex
  const capture = (...a: any[]) => { out.push(a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '')); };
  spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCodes.push(code); throw new Error('exit'); }) as any),
  ];
  cwd = process.cwd();
  // realpath: on macOS the tmpdir is a /var -> /private/var symlink, and the
  // messages name the resolved project root.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-unlinked-')));
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/items')) return { data: [ELSEWHERE, HERE] } as any;
    if (url.endsWith('/projects/p1/flow') || url.endsWith('/projects/other/flow')) return { data: FLOW } as any;
    if (url.endsWith('/projects/p1')) return { data: { id: 'p1', projectRoot: null } } as any;
    if (url.includes('/leave-plan')) throw new Error('404');
    throw new Error(`unexpected ${url}`);
  });
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.clearAllMocks();
});

/** A directory holding .agenfk with the given files; returns its path. */
function project(name: string, files: { local?: object; shared?: object }) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  if (files.local) fs.writeFileSync(path.join(dir, '.agenfk', 'local.json'), JSON.stringify(files.local));
  if (files.shared) fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify(files.shared));
  return dir;
}

async function gatekeeper(dir: string, ...extra: string[]) {
  process.chdir(dir);
  try { await program.parseAsync(['node', 'agenfk', 'gatekeeper', '--intent', 'x', ...extra]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}
/** The one JSON line --json prints. */
const jsonOf = (text: string) => JSON.parse(text.split('\n').find(l => l.startsWith('{')) ?? 'null');
const fetchedItems = () => mockedAxios.get.mock.calls.some(([url]) => String(url).endsWith('/items'));

describe('agenfk gatekeeper in a project this machine has not linked', () => {
  // A fresh clone: the shared project.json, no local.json.
  const clone = () => project('clone', { shared: { verifyCommand: 'npm test' } });

  it('refuses, says how to link it, and never weighs another project\'s tasks', async () => {
    const dir = clone();
    const text = await gatekeeper(dir);
    expect(text).toContain(`❌ WORKFLOW BREACH: ${dir} is an AgEnFK project not linked on this machine`);
    expect(text).toContain('agenfk init --project <id> (agenfk list-projects lists them)');
    expect(text).not.toMatch(/AUTHORIZED/);
    expect(exitCodes[0]).toBe(1);
    expect(fetchedItems()).toBe(false);
  });

  it('--json says so too', async () => {
    const json = jsonOf(await gatekeeper(clone(), '--json'));
    expect(json).toMatchObject({ authorized: false, notLinked: true, task: null });
    expect(json.message).toContain('not linked on this machine');
  });

  it('refuses with --item-id as well, rather than following the card into another project', async () => {
    const text = await gatekeeper(clone(), '--item-id', ELSEWHERE.id);
    expect(text).toContain('not linked on this machine');
    expect(text).not.toMatch(/AUTHORIZED/);
    expect(fetchedItems()).toBe(false);
  });

  it('in a linked worktree of an unlinked checkout, points at the main checkout', async () => {
    const main = project('main', { shared: { verifyCommand: 'npm test' } });
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'config'), '[core]\n\tbare = false\n');
    const worktree = project('feature', { shared: { verifyCommand: 'npm test' } });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);

    const text = await gatekeeper(worktree);
    expect(text).toContain(`❌ WORKFLOW BREACH: this is a git worktree of ${main}, which is not linked`);
    expect(text).toContain(`cd ${main} && agenfk init --project <id>`);
    expect(exitCodes[0]).toBe(1);
  });
});

describe('agenfk gatekeeper in a linked project is unchanged', () => {
  it("authorizes on the project's own active task", async () => {
    const text = await gatekeeper(project('linked', { local: { projectId: 'p1' } }));
    expect(text).toMatch(/AUTHORIZED/);
    expect(text).toContain(`[${HERE.id.substring(0, 8)}] ${HERE.title}`);
    expect(exitCodes[0]).toBe(0);
  });
});
