/**
 * BUG 98aab7b6 (CGLAB-434): `agenfk init` registered the MCP server on every
 * machine with Claude Code, whatever the install chose.
 *
 * CLI-only is the default: install.mjs records `withMcp` in
 * ~/.agenfk/config.json and, without it, removes the MCP registration
 * ("Ensuring CLI-only mode"). init never read that flag - with `claude` on
 * PATH it ran `claude mcp add --scope user ...` and wrote the mcp__agenfk__*
 * permissions into .claude/settings.local.json, undoing the install for
 * every project.
 *
 * Contract under test:
 *  - CLI-only install (no withMcp): init calls no `claude mcp` and writes no
 *    settings.local.json, and says how to add the integration.
 *  - withMcp install: init registers the server and writes the permissions.
 *  - `agenfk configure-ide` asked for it explicitly: registers on any install.
 *  - A failure in the IDE step after a successful init is reported as that,
 *    never as "Could not connect to API server", and a missing db path is a
 *    warning, not a red error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

/** Every `claude ...` command line the CLI ran, through either exec route. */
const claudeCalls = () => [
  ...execSync.mock.calls.map(c => String(c[0])),
  ...spawnSync.mock.calls.map(c => [c[0], ...(c[1] ?? [])].join(' ')),
].filter(c => c.startsWith('claude'));

const writeConfig = (cfg: Record<string, unknown>) => {
  fs.mkdirSync(path.join(home.dir, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(home.dir, '.agenfk', 'config.json'), JSON.stringify(cfg));
};
const localSettings = () => path.join(dir, '.claude', 'settings.local.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-init-mcp-'));
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-init-mcp-home-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  out = []; err = [];
  // eslint-disable-next-line no-control-regex
  const strip = (a: any[]) => a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(strip(a)); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(strip(a)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  // Claude Code IS installed on this machine.
  execSync.mockReturnValue('');
  spawnSync.mockReturnValue({ status: 0 });
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

describe('agenfk init on a CLI-only install with Claude Code present (BUG 98aab7b6)', () => {
  it('registers no MCP server and writes no MCP permissions', async () => {
    writeConfig({ dbPath: '/db.sqlite', withMcp: false });

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    expect(JSON.parse(fs.readFileSync(path.join(dir, '.agenfk', 'project.json'), 'utf8'))).toEqual({ projectId: 'p-123' });
    expect(claudeCalls().filter(c => c.includes(' mcp '))).toEqual([]);
    expect(fs.existsSync(localSettings())).toBe(false);
  });

  it('treats a config with no withMcp at all as CLI-only (the default)', async () => {
    writeConfig({ dbPath: '/db.sqlite' });

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    expect(claudeCalls().filter(c => c.includes(' mcp '))).toEqual([]);
    expect(fs.existsSync(localSettings())).toBe(false);
  });

  it('says it is a CLI-only install and how to add the integration, with no error', async () => {
    writeConfig({ dbPath: '/db.sqlite', withMcp: false });

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    expect(err, err.join('\n')).toEqual([]);
    expect(out.join('\n')).toMatch(/CLI-only/);
    expect(out.join('\n')).toMatch(/agenfk configure-ide/);
    expect(out.join('\n')).toMatch(/agenfk integration install claude --with-mcp/);
  });
});

describe('agenfk init on a --with-mcp install with Claude Code present', () => {
  it('registers the MCP server at user scope and writes its permissions', async () => {
    writeConfig({ dbPath: '/db.sqlite', withMcp: true });

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    expect(claudeCalls().some(c => c.startsWith('claude mcp add') && c.includes('--scope user'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(localSettings(), 'utf8'));
    expect(settings.permissions.allow).toContain('mcp__agenfk__workflow_gatekeeper');
    expect(err, err.join('\n')).toEqual([]);
  });

  it('warns rather than errors when the db path cannot be determined', async () => {
    writeConfig({ withMcp: true });

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    expect(err, err.join('\n')).toEqual([]);
    expect(out.join('\n')).toMatch(/AGENFK_DB_PATH/);
    expect(out.join('\n')).toMatch(/agenfk configure-ide/);
  });

  it('reports a failure inside the IDE step as that, not as an unreachable API server', async () => {
    writeConfig({ dbPath: '/db.sqlite', withMcp: true });
    // A real way for the step to throw: `.claude` is a file, so writing
    // .claude/settings.local.json fails (ENOTDIR; ENOENT on Windows).
    fs.writeFileSync(path.join(dir, '.claude'), 'not a directory');

    await program.parseAsync(['node', 'agenfk', 'init', 'demo']);

    const all = [...out, ...err].join('\n');
    expect(all).not.toMatch(/Could not connect to API server/);
    expect(all).toMatch(/MCP setup failed: .*(ENOTDIR|ENOENT)/); // ENOENT on Windows
    expect(all).toMatch(/agenfk configure-ide/);
    // The project itself was initialized before the IDE step ran.
    expect(fs.existsSync(path.join(dir, '.agenfk', 'project.json'))).toBe(true);
  });
});

describe('agenfk configure-ide, asked for explicitly', () => {
  it('registers the MCP server even on a CLI-only install', async () => {
    writeConfig({ dbPath: '/db.sqlite', withMcp: false });
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p-123' }));

    await program.parseAsync(['node', 'agenfk', 'configure-ide']);

    expect(claudeCalls().some(c => c.startsWith('claude mcp add'))).toBe(true);
    expect(fs.existsSync(localSettings())).toBe(true);
  });
});
