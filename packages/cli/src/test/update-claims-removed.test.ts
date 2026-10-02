/**
 * `agenfk update --claims` is gone with the claims mechanism (26c059f6).
 *
 * The flag declared the paths a card owned. Claims were removed because they
 * locked parallel work, and the flag went with them rather than staying as a
 * no-op: an option that does nothing teaches agents a step that no longer
 * exists.
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
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';
const PROJECT = '33333333-3333-3333-3333-333333333333';
const ITEM = '11111111-1111-1111-1111-111111111111';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

const outputText = () =>
  [...logSpy.mock.calls, ...errorSpy.mock.calls].map(c => c.join(' ')).join('\n');

describe('agenfk update --claims', () => {
  it('is no longer an option of update', () => {
    const update = program.commands.find(c => c.name() === 'update')!;
    const flags = update.options.map(o => o.long);
    expect(flags).not.toContain('--claims');
  });

  it('an ordinary update sends no claims field', async () => {
    mockedAxios.put.mockResolvedValue({ data: { id: ITEM, title: 'New title', type: 'TASK', status: 'TODO' } });

    await program.parseAsync(['node', 'agenfk', 'update', ITEM, '--title', 'New title']);

    expect(mockedAxios.put).toHaveBeenCalledTimes(1);
    expect(mockedAxios.put.mock.calls[0][1] as Record<string, unknown>).not.toHaveProperty('claims');
  });
});
