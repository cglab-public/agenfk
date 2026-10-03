/**
 * BUG 5cc7de1e: on a machine without Claude Code, `agenfk init` printed a red
 * "Error: claude CLI not found in PATH" after it had created the project. The
 * Claude Code IDE step that follows init is optional (CLI-only is the default,
 * and Codex/Cursor/pi users have no `claude`), so init says it succeeded and
 * that the step was skipped. `agenfk configure-ide`, asked for explicitly,
 * still reports a missing `claude` as the error it is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A HOME of the test's own: init reads ~/.agenfk/config.json (BUG 98aab7b6).
const { home } = vi.hoisted(() => ({ home: { dir: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => home.dir || actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) { this.capture = vi.fn(); this.shutdown = vi.fn().mockResolvedValue(undefined); this.isEnabled = false; }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
const { execSync, spawnSync } = vi.hoisted(() => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('child_process', () => ({
  execSync, execFileSync: vi.fn(), spawn: vi.fn(), spawnSync,
  default: { execSync, execFileSync: vi.fn(), spawn: vi.fn(), spawnSync },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import axios from 'axios';
import { program } from '../index';

const mockedAxios = vi.mocked(axios, true);
let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-init-'));
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-init-home-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  out = []; err = [];
  // eslint-disable-next-line no-control-regex
  const strip = (a: any[]) => a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(strip(a)); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(strip(a)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  // No Claude Code on this machine.
  execSync.mockImplementation((cmd: string) => {
    if (String(cmd).startsWith('claude')) throw Object.assign(new Error('claude: command not found'), { status: 127 });
    return '';
  });
  // claude is launched through runTool, which spawns it (BUG ad57c267): not installed = ENOENT.
  spawnSync.mockImplementation((cmd: string) => (String(cmd) === 'claude'
    ? { status: null, error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }) }
    : { status: 0 }));
  mockedAxios.get.mockResolvedValue({ data: { message: 'AgEnFK Framework API is running' } } as any);
  mockedAxios.post.mockResolvedValue({ data: { id: 'p-123', name: 'demo' } } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  execSync.mockReset();
  spawnSync.mockReset();
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home.dir, { recursive: true, force: true });
  home.dir = '';
});

/** A --with-mcp install: the only one where init looks for Claude Code (BUG 98aab7b6). */
const withMcpInstall = () => {
  fs.mkdirSync(path.join(home.dir, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(home.dir, '.agenfk', 'config.json'), JSON.stringify({ dbPath: '/db.sqlite', withMcp: true }));
};

describe('agenfk init on a machine without Claude Code (BUG 5cc7de1e)', () => {
  it('initializes the project and prints no error', async () => {
    withMcpInstall();
    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.agenfk', 'project.json'), 'utf8'))).toEqual({ projectId: 'p-123' });
    expect(err, err.join('\n')).toEqual([]);
    expect(out.join('\n')).not.toMatch(/Error/);
  });

  it('says the Claude Code step was skipped and how to run it later', async () => {
    withMcpInstall();
    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);
    expect(err, err.join('\n')).toEqual([]);
    const text = out.join('\n');
    expect(text).toMatch(/Initialized project/);
    expect(text).toMatch(/Claude Code .*not found.*skipped/i);
    // configure-ide adds the MCP integration; it is offered as that, not as a missing step.
    expect(text).toMatch(/MCP integration later, run: agenfk configure-ide/);
  });
});

describe('agenfk init on a CLI-only install without Claude Code', () => {
  it('initializes the project, prints no error, and never looks for claude', async () => {
    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);
    expect(fs.existsSync(path.join(dir, '.agenfk', 'project.json'))).toBe(true);
    expect(err, err.join('\n')).toEqual([]);
    const claudeLaunches = [...execSync.mock.calls, ...spawnSync.mock.calls].map(c => String(c[0])).filter(c => /(^|[\\/"])claude(\.(exe|cmd|bat))?\b/.test(c));
    expect(claudeLaunches).toEqual([]);
  });
});

describe('agenfk configure-ide without Claude Code', () => {
  it('still reports the missing claude CLI as an error, since it was asked for', async () => {
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p-123' }));
    await expect(program.parseAsync(['node', 'agenfk', 'configure-ide'])).rejects.toThrow('exit 1');
    expect(err.join('\n')).toMatch(/claude CLI not found/);
    // ...and only that cause, not a second line blaming ~/.claude/settings.json.
    expect(err.join('\n')).not.toMatch(/settings\.json/);
  });
});
