/**
 * `agenfk airlock` (GH-294, T2): status, check and edit. The CLI is the agent's
 * route to the server, so none of them writes the policy: edit only points a
 * person at the board.
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
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
const printed = () => logSpy.mock.calls.flat().join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  // No server-port file: the dashboard is on the default port.
  mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

const status = { effective: { mode: 'observe', models: [] }, source: 'hub', revision: 4, hubManaged: true, local: null, hub: { revision: 4 } };

describe('agenfk airlock status', () => {
  it('status prints mode/source/revision', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: status });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'status']);
    expect(mockedAxios.get).toHaveBeenCalledWith(`${API}/airlock/policy`);
    const out = printed();
    expect(out).toContain('observe');
    expect(out).toContain('hub');
    expect(out).toContain('4');
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('--json prints the server answer as JSON', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: status });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'status', '--json']);
    expect(JSON.parse(printed())).toEqual(status);
  });

  it('a server it cannot reach is an error exit', async () => {
    mockedAxios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await program.parseAsync(['node', 'agenfk', 'airlock', 'status']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('agenfk airlock check', () => {
  it('posts a dry-run evaluate and prints the verdict', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { verdict: { decision: 'deny', rule: 'builtin-metadata-deny', reason: 'cloud metadata' }, mode: 'enforce', applies: true, revision: 2 } });
    await program.parseAsync(['node', 'agenfk', 'airlock', 'check', '--client', 'pi', '--model', 'cloudflare/glm', '--command', 'curl http://169.254.169.254/']);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0] as any[];
    expect(url).toBe(`${API}/airlock/evaluate`);
    expect(body).toMatchObject({ client: 'pi', model: 'cloudflare/glm', dryRun: true, args: { command: 'curl http://169.254.169.254/' } });
    expect(printed()).toContain('deny');
    expect(printed()).toContain('builtin-metadata-deny');
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it('refuses without a command, path or url', async () => {
    await program.parseAsync(['node', 'agenfk', 'airlock', 'check', '--client', 'pi']);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('agenfk airlock edit', () => {
  it('edit prints board URL and issues no PUT', async () => {
    await program.parseAsync(['node', 'agenfk', 'airlock', 'edit']);
    expect(printed()).toContain('http://localhost:3000');
    expect(printed()).toMatch(/airlock/i);
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });
});
