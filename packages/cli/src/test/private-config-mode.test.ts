/**
 * BUG cc26b206: `agenfk jira setup` wrote ~/.agenfk/config.json, which holds
 * the JIRA clientSecret, with no mode, so under umask 022 it was 0644 and any
 * local user could read the secret. Every CLI writer of config.json must leave
 * it 0600, including one that rewrites a file an older release left 0644.
 *
 * Real files in a sandboxed home: the claim is about what is on disk, and a
 * mocked fs can only show what the code asked for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

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
vi.mock('child_process', () => {
  // `pause` runs the uninstaller for the integration; it succeeds here.
  const spawnSync = vi.fn(() => ({ status: 0 }));
  return { execSync: vi.fn(), spawn: vi.fn(), spawnSync, default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync } };
});
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
const { mockCreateInterface } = vi.hoisted(() => ({ mockCreateInterface: vi.fn() }));
vi.mock('readline', () => ({ createInterface: mockCreateInterface, default: { createInterface: mockCreateInterface } }));

import { program } from '../index';

const posix = process.platform !== 'win32';
let home: string;
let proj: string;
let oldUmask: number;
const configFile = () => path.join(home, '.agenfk', 'config.json');
const mode = (p: string) => fs.statSync(p).mode & 0o777;

/** Answers the prompts in order: Client ID, Client Secret, Redirect URI. */
function answer(...answers: string[]) {
  const queue = [...answers];
  mockCreateInterface.mockReturnValue({
    question: (_q: string, cb: (a: string) => void) => cb(queue.shift() ?? ''),
    close: vi.fn(),
  });
}

async function run(...args: string[]) {
  await program.parseAsync(['node', 'agenfk', ...args]);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-private-config-'));
  vi.mocked(os.homedir).mockReturnValue(home);
  // BUG 181b3a5f: never the directory the suite was launched from. A developer
  // checkout carries an untracked .agenfk/project.json there and CI's does not,
  // so a command that looks up the project passed locally and failed in CI.
  // It also keeps `skills install` (whose project root falls back to the cwd)
  // from sweeping agenfk entries out of the real repo root. A directory of its
  // own, not HOME, so a lookup that wrongly used the home dir would not pass.
  proj = fs.mkdtempSync(path.join(home, 'proj-'));
  vi.spyOn(process, 'cwd').mockReturnValue(proj);
  delete process.env.AGENFK_HUB_URL;
  oldUmask = process.umask(0o022);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
});
afterEach(() => {
  process.umask(oldUmask);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe.runIf(posix)('CLI writers of ~/.agenfk/config.json keep it private', () => {
  it('jira setup writes the client secret to a 0600 file', async () => {
    answer('cid', 'the-secret', '');
    await run('jira', 'setup');
    await vi.waitFor(() => expect(fs.existsSync(configFile())).toBe(true));
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).jira.clientSecret).toBe('the-secret');
    expect(mode(configFile())).toBe(0o600);
  });

  it('jira setup tightens a config.json an older release left 0644', async () => {
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    fs.writeFileSync(configFile(), '{"flowRegistry":"a/b"}');
    fs.chmodSync(configFile(), 0o644);
    answer('cid', 'the-secret', '');
    await run('jira', 'setup');
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).jira).toBeTruthy());
    expect(mode(configFile())).toBe(0o600);
  });

  it('config set flowRegistry leaves a file holding the secret 0600', async () => {
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ jira: { clientSecret: 's' } }));
    fs.chmodSync(configFile(), 0o644);
    await run('config', 'set', 'flowRegistry', 'cglab-public/flows');
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).flowRegistry).toBe('cglab-public/flows');
    expect(mode(configFile())).toBe(0o600);
  });

  // Review finding: every converted writer is pinned, not just two of them.
  const secretConfig = (extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ jira: { clientSecret: 's' }, ...extra }));
    fs.chmodSync(configFile(), 0o644);
  };
  const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));

  it('pause (integrations) leaves it 0600', async () => {
    secretConfig();
    await run('pause', 'claude', '-y');
    expect(readConfig().pausedIntegrations).toContain('claude');
    expect(mode(configFile())).toBe(0o600);
  });

  /** github setup links the project found from the cwd, so the cwd is one. */
  const inProject = () => {
    fs.mkdirSync(path.join(proj, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p-1' }));
  };

  it('github setup leaves it 0600', async () => {
    secretConfig();
    inProject();
    await run('github', 'setup', '--owner', 'cglab', '--repo', 'agenfk');
    expect(Object.values(readConfig().github.repos)).toContainEqual(expect.objectContaining({ owner: 'cglab', repo: 'agenfk' }));
    expect(mode(configFile())).toBe(0o600);
  });

  it('github disconnect leaves it 0600', async () => {
    inProject();
    await run('github', 'setup', '--owner', 'cglab', '--repo', 'agenfk');
    fs.chmodSync(configFile(), 0o644);
    await run('github', 'disconnect');
    expect(readConfig().github).toBeUndefined();
    expect(mode(configFile())).toBe(0o600);
  });

  it('skills install and uninstall leave it 0600', async () => {
    secretConfig();
    await run('skills', 'install');
    expect(readConfig().rulesScope).toBe('global');
    expect(mode(configFile())).toBe(0o600);
    fs.chmodSync(configFile(), 0o644);
    await run('skills', 'uninstall');
    expect(readConfig().rulesScope).toBeUndefined();
    expect(mode(configFile())).toBe(0o600);
  });
});
