/**
 * `agenfk jira setup|disconnect|status` on an installation joined to a hub
 * (CGLAB-412).
 *
 * JIRA for a joined installation is configured once, on the hub, by an admin
 * (the org's Atlassian app); each user then connects their OWN JIRA through
 * the hub from the board. So locally `setup` is an error that says who to ask
 * - it must not prompt or touch ~/.agenfk/config.json - `disconnect` drops
 * the user's hub connection via the server (never the local token file), and
 * `status` reports the hub's view instead of local files. "Joined"
 * follows the server's own rule (hubClient.loadHubConfig): the AGENFK_HUB_*
 * env vars override ~/.agenfk/hub.json, and all of url, token and orgId must
 * be present. Unjoined installations keep today's behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
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

vi.mock('fs', () => {
  const api = {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
    mkdirSync: vi.fn(),
  };
  return { ...api, default: api };
});

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
const { mockCreateInterface } = vi.hoisted(() => ({ mockCreateInterface: vi.fn() }));
vi.mock('readline', () => ({ createInterface: mockCreateInterface, default: { createInterface: mockCreateInterface } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const HUB_JSON = path.join(os.homedir(), '.agenfk', 'hub.json');
const TOKEN_FILE = path.join(os.homedir(), '.agenfk', 'jira-token.json');
const CONFIG_FILE = path.join(os.homedir(), '.agenfk', 'config.json');
const HUB_ENV = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG'] as const;
const savedEnv: Record<string, string | undefined> = {};

let files: Record<string, string>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const joined = () => {
  files[HUB_JSON] = JSON.stringify({ url: 'https://hub.acme.test', token: 'agk_x', orgId: 'acme' });
};
const output = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].map(c => c.join(' ')).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of HUB_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  files = {
    [TOKEN_FILE]: JSON.stringify({ access_token: 'a', refresh_token: 'r', cloudId: 'local-cloud', cloudUrl: 'https://local.atlassian.net', email: 'me@local.test' }),
    [CONFIG_FILE]: JSON.stringify({ jira: { clientId: 'local-cid', clientSecret: 's' } }),
  };
  mockExistsSync.mockImplementation((p: string) => p in files);
  mockReadFileSync.mockImplementation((p: string) => {
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
  mockCreateInterface.mockReturnValue({ question: vi.fn(), close: vi.fn() });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as any);
});

afterEach(() => {
  for (const k of HUB_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const run = (...args: string[]) => program.parseAsync(['node', 'agenfk', 'jira', ...args]).catch((e: Error) => e);

describe('agenfk jira on a hub-joined installation', () => {
  it('setup fails with an ask-your-admin error, without prompting or writing config', async () => {
    joined();
    const r = await run('setup');
    expect((r as Error)?.message).toBe('exit:1');
    expect(output()).toMatch(/hub admin/i);
    expect(output()).toContain('https://hub.acme.test');
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('the AGENFK_HUB_* env vars count as joined, like the server', async () => {
    process.env.AGENFK_HUB_URL = 'https://env-hub.acme.test';
    process.env.AGENFK_HUB_TOKEN = 'agk_env';
    process.env.AGENFK_HUB_ORG = 'acme';
    const r = await run('setup');
    expect((r as Error)?.message).toBe('exit:1');
    expect(output()).toContain('https://env-hub.acme.test');
  });

  it('disconnect drops YOUR hub connection through the server, leaving the local token file alone', async () => {
    joined();
    mockedAxios.post.mockResolvedValue({ data: { disconnected: true } });
    const r = await run('disconnect');
    expect(r).not.toBeInstanceOf(Error);
    expect(mockedAxios.post).toHaveBeenCalledWith('http://localhost:3000/jira/disconnect', {}, expect.anything());
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(output()).toMatch(/disconnected/i);
  });

  it('disconnect fails loudly when the server cannot reach the hub', async () => {
    joined();
    mockedAxios.post.mockRejectedValue({ response: { data: { error: 'The hub could not disconnect JIRA.' } } });
    const r = await run('disconnect');
    expect((r as Error)?.message).toBe('exit:1');
    expect(output()).toContain('The hub could not disconnect JIRA.');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('status reports the hub connection from the server, not local files', async () => {
    joined();
    mockedAxios.get.mockResolvedValue({ data: { source: 'hub', configured: true, connected: true, cloudUrl: 'https://acme.atlassian.net', email: 'bot@acme.test' } });
    await run('status');
    const out = output();
    expect(out).toContain('https://hub.acme.test');
    expect(out).toContain('https://acme.atlassian.net');
    expect(out).toContain('bot@acme.test');
    expect(out).not.toContain('local-cid');
    expect(out).not.toContain('me@local.test');
  });

  it('status on a hub with no JIRA app says to ask a hub admin', async () => {
    joined();
    mockedAxios.get.mockResolvedValue({ data: { source: 'hub', configured: false, connected: false, message: 'x' } });
    await run('status');
    expect(output()).toMatch(/hub admin/i);
  });

  it('status when the app is there but you have not connected says how to connect', async () => {
    joined();
    mockedAxios.get.mockResolvedValue({ data: { source: 'hub', configured: true, connected: false } });
    await run('status');
    expect(output()).toMatch(/connect jira/i);
    expect(output()).not.toMatch(/hub admin/i);
  });
});

describe('agenfk jira status when the hub rejects the installation key', () => {
  it('points at hub login, not at a hub admin', async () => {
    joined();
    mockedAxios.get.mockResolvedValue({ data: { source: 'hub', configured: false, connected: false, reason: 'hub_auth_failed' } });
    await run('status');
    expect(output()).toContain('agenfk hub login');
    expect(output()).not.toMatch(/ask a hub admin/i);
  });
});

describe('agenfk jira on an unjoined installation (unchanged)', () => {
  it('a partial hub.json is not completed by an env var - the server would not count it either', async () => {
    files[HUB_JSON] = JSON.stringify({ url: 'https://hub.acme.test', token: 'agk_x' });
    process.env.AGENFK_HUB_ORG = 'acme';
    const r = await run('disconnect');
    expect(r).not.toBeInstanceOf(Error);
    expect(mockUnlinkSync).toHaveBeenCalledWith(TOKEN_FILE);
  });

  it('a hub.json missing a field is not joined', async () => {
    files[HUB_JSON] = JSON.stringify({ url: 'https://hub.acme.test', token: 'agk_x' });
    const r = await run('disconnect');
    expect(r).not.toBeInstanceOf(Error);
    expect(mockUnlinkSync).toHaveBeenCalledWith(TOKEN_FILE);
  });

  it('disconnect still removes the local token', async () => {
    const r = await run('disconnect');
    expect(r).not.toBeInstanceOf(Error);
    expect(mockUnlinkSync).toHaveBeenCalledWith(TOKEN_FILE);
  });

  it('setup still prompts locally', async () => {
    void run('setup');
    await vi.waitFor(() => expect(mockCreateInterface).toHaveBeenCalled());
    expect(output()).not.toMatch(/hub admin/i);
  });

  it('status still reads the local configuration', async () => {
    mockedAxios.get.mockResolvedValue({ data: { configured: true, connected: true } });
    await run('status');
    expect(output()).toContain('local-cid');
  });
});
