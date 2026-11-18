/**
 * `agenfk delete 2cab541` and `agenfk move 2cab541 <project>` resolved a short
 * id to the FIRST item whose id started with it, even when several did - so a
 * destructive command could hit a card nobody named. `get` and `update` already
 * refused an ambiguous prefix. Both now resolve the id with resolveItemIdPrefix:
 * an ambiguous prefix is refused with the candidates listed, exit 1, and
 * nothing is deleted or moved.
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
const ITEMS = [
  { id: FULL, title: 'The one meant' },
  { id: TWIN_A, title: 'First twin' },
  { id: TWIN_B, title: 'Second twin' },
];
const TARGET_PROJECT = 'p-target';

let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url === `${API}/items`) return { data: ITEMS };
    throw new Error(`unexpected GET ${url}`);
  });
  mockedAxios.delete.mockResolvedValue({ status: 204 });
  mockedAxios.post.mockImplementation(async (url: string) => ({
    data: { item: { id: url.split('/')[4], title: 't' }, movedCount: 1 },
  }));
});

/** Every request that would change an item. */
function writes() {
  return [...mockedAxios.delete.mock.calls, ...mockedAxios.post.mock.calls, ...mockedAxios.put.mock.calls];
}

const commands: Array<[string, (id: string) => string[], (id: string) => string]> = [
  ['delete', id => ['delete', id], id => `${API}/items/${id}`],
  ['move', id => ['move', id, TARGET_PROJECT], id => `${API}/items/${id}/move`],
];

describe.each(commands)('agenfk %s <id> with a short id', (name, argv, writeUrl) => {
  it('refuses an ambiguous prefix, lists the candidates and changes nothing', async () => {
    await program.parseAsync(['node', 'agenfk', ...argv('2cab541')]);

    expect(writes()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errorSpy.mock.calls.flat().join(' ');
    expect(err).toContain('Ambiguous ID 2cab541');
    expect(err).toContain(TWIN_A);
    expect(err).toContain(TWIN_B);
    expect(err).not.toContain(FULL);
  });

  it('resolves a unique prefix to the full id', async () => {
    await program.parseAsync(['node', 'agenfk', ...argv(FULL.slice(0, 8))]);

    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe(writeUrl(FULL));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('takes a full id as-is, without listing the items', async () => {
    await program.parseAsync(['node', 'agenfk', ...argv(TWIN_A)]);

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(writes()[0][0]).toBe(writeUrl(TWIN_A));
  });

  it('fails when no item starts with the prefix', async () => {
    await program.parseAsync(['node', 'agenfk', ...argv('deadbeef')]);

    expect(writes()).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('No item found starting with deadbeef');
  });
});
