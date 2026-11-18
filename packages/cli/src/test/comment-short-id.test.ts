/**
 * `agenfk get d1ff2cf4` resolved an 8-char prefix, but `agenfk comment d1ff2cf4 "…"`
 * failed with "Item not found": comment sent the value straight to GET/PUT
 * /items/:id, which match the EXACT id. add-context and log-test had the same
 * read-modify-write shape and the same gap. They now resolve the id the way
 * `get` does (resolveItemIdPrefix) and refuse an ambiguous prefix.
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
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

const FULL = 'd1ff2cf4-6b1e-4c3a-9a51-0e7f6c2b8d10';
const TWIN_A = '2cab541e-d262-4241-a0fa-104b894ffb98';
const TWIN_B = '2cab541f-0000-0000-0000-000000000000';
const ITEMS = [{ id: FULL }, { id: TWIN_A }, { id: TWIN_B }];

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
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url === `${API}/items`) return { data: ITEMS };
    const id = url.slice(`${API}/items/`.length);
    if (ITEMS.some(i => i.id === id)) return { data: { id } };
    throw Object.assign(new Error('Request failed with status code 404'), { response: { data: { error: 'Item not found' } } });
  });
  mockedAxios.put.mockResolvedValue({ data: {} });
});

const commands: Array<[string, string[]]> = [
  ['comment', ['hello']],
  ['add-context', ['--path', 'docs/spec.md']],
  ['log-test', ['--command', 'npm test', '--output', 'ok', '--status', 'PASSED']],
];

describe.each(commands)('agenfk %s <id> accepts the id forms `get` does', (name, rest) => {
  it('resolves a unique 8-char prefix to the full id', async () => {
    await program.parseAsync(['node', 'agenfk', name, FULL.slice(0, 8), ...rest]);

    expect(mockedAxios.get).toHaveBeenCalledWith(`${API}/items/${FULL}`);
    expect(mockedAxios.put).toHaveBeenCalledTimes(1);
    expect(mockedAxios.put.mock.calls[0][0]).toBe(`${API}/items/${FULL}`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('takes a full id as-is, without listing the items', async () => {
    await program.parseAsync(['node', 'agenfk', name, FULL, ...rest]);

    expect(mockedAxios.get).not.toHaveBeenCalledWith(`${API}/items`);
    expect(mockedAxios.put.mock.calls[0][0]).toBe(`${API}/items/${FULL}`);
  });

  it('refuses an ambiguous prefix and writes nothing', async () => {
    await program.parseAsync(['node', 'agenfk', name, '2cab541', ...rest]);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(errorSpy.mock.calls.flat().join(' '))).toContain('Ambiguous ID 2cab541');
  });

  it('says so when no item starts with the prefix', async () => {
    await program.parseAsync(['node', 'agenfk', name, 'deadbeef', ...rest]);

    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(errorSpy.mock.calls.flat().join(' '))).toContain('No item found starting with deadbeef');
  });
});
