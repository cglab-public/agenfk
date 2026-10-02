/**
 * `agenfk get` leaves step records out unless asked (TASK a5f09e66, BUG
 * ec325925). The server now omits them from GET /items/:id unless
 * ?records=1; `--records` is how the CLI asks.
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
const ID = '11111111-1111-1111-1111-111111111111';
const CARD = { id: ID, type: 'TASK', title: 'A card', status: 'TODO', projectId: 'p' };

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  mockedAxios.get.mockResolvedValue({ data: CARD });
});

const urls = () => mockedAxios.get.mock.calls.map(c => String(c[0]));

describe('agenfk get and step records', () => {
  it('asks for the card without its records by default', async () => {
    await program.parseAsync(['node', 'agenfk', 'get', ID, '--json']);
    expect(urls().at(-1)).toMatch(new RegExp(`/items/${ID}$`));
  });

  it('asks for the records with --records', async () => {
    await program.parseAsync(['node', 'agenfk', 'get', ID, '--json', '--records']);
    expect(urls().at(-1)).toMatch(new RegExp(`/items/${ID}\\?records=1$`));
  });

  it('documents --records in its help', () => {
    const get = program.commands.find(c => c.name() === 'get');
    expect(get?.options.map(o => o.long)).toContain('--records');
  });
});
