/**
 * Story 6, by behaviour (replaces the source scans in hub-join-restart.test.ts):
 * after a successful `agenfk hub join`, a running local API server is bounced
 * - `agenfk down`, then `agenfk up` - so it picks up the new hub.json. A server
 * that is not running is left alone, and --no-restart skips the bounce.
 *
 * child_process is mocked: the real join would run `node packages/cli/bin/agenfk.js down`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-join-restart-'));
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

const { mockGet, mockPost, calls, execSync, spawn } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    mockGet: vi.fn(),
    mockPost: vi.fn(),
    calls,
    execSync: vi.fn((cmd: string) => { calls.push(`execSync ${cmd}`); return ''; }),
    spawn: vi.fn((cmd: string, args: string[]) => { calls.push(`spawn ${cmd} ${args.join(' ')}`); return { unref: () => undefined }; }),
  };
});
vi.mock('axios', () => ({ default: { get: mockGet, post: mockPost } }));
vi.mock('child_process', () => {
  const execFileSync = vi.fn(() => '');
  const exec = vi.fn();
  return { execSync, spawn, execFileSync, exec, default: { execSync, spawn, execFileSync, exec } };
});
vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://127.0.0.1:9',
  getInstallationId: () => 'inst-test',
}));

const { registerHubCommands } = await import('../commands/hub.js');

const HUB_CONFIG = path.join(sandboxHome, '.agenfk', 'hub.json');

describe('agenfk hub join bounces a running local server', () => {
  let program: Command;
  let logs: string[];
  const spies: Array<{ mockRestore: () => void }> = [];

  /** The hub answers healthz and the redeem; `serverUp` says whether the local API answers. */
  function world(serverUp: boolean) {
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/healthz')) return { status: 200, data: { service: 'agenfk-hub' } };
      if (url.startsWith('http://127.0.0.1:9')) {
        if (!serverUp) throw new Error('ECONNREFUSED');
        return { status: 200, data: {} };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    mockPost.mockResolvedValue({ data: { token: 'newtok', orgId: 'acme', hubUrl: 'https://hub.example.com' } });
  }
  const join = (...extra: string[]) => program.parseAsync(['node', 'agenfk', 'hub', 'join', 'https://hub.example.com', 'INVITE', ...extra]);
  const lifecycle = () => calls.filter(c => /agenfk\.js\b.*\b(down|up)\b/.test(c));

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    fs.mkdirSync(path.dirname(HUB_CONFIG), { recursive: true });
    try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
    mockGet.mockReset();
    mockPost.mockReset();
    calls.length = 0;
    logs = [];
    spies.push(
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any),
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    );
  });
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });
  afterAll(() => fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('runs `agenfk down` then `agenfk up` when the local server is running', async () => {
    world(true);
    await join();
    const steps = lifecycle();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/\bdown\b/);
    expect(steps[1]).toMatch(/\bup\b/);
  });

  it('writes hub.json before it restarts, so the restarted server reads the new config', async () => {
    world(true);
    let configAtDown: string | null = null;
    execSync.mockImplementationOnce((cmd: string) => {
      calls.push(`execSync ${cmd}`);
      configAtDown = fs.existsSync(HUB_CONFIG) ? fs.readFileSync(HUB_CONFIG, 'utf8') : null;
      return '';
    });
    await join();
    expect(configAtDown).not.toBeNull();
    expect(JSON.parse(configAtDown!)).toMatchObject({ url: 'https://hub.example.com', token: 'newtok', orgId: 'acme' });
  });

  it('leaves a server that is not running alone, and says the next `agenfk up` picks the config up', async () => {
    world(false);
    await join();
    expect(lifecycle()).toEqual([]);
    expect(logs.join('\n')).toMatch(/not running/i);
    expect(fs.existsSync(HUB_CONFIG)).toBe(true);
  });

  it('with --no-restart, neither probes nor bounces the server', async () => {
    world(true);
    await join('--no-restart');
    expect(lifecycle()).toEqual([]);
    expect(mockGet.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('http://127.0.0.1:9/') && !u.includes('/internal/'))).toEqual([]);
    expect(fs.existsSync(HUB_CONFIG)).toBe(true);
  });
});
