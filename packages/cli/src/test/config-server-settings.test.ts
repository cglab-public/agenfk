/**
 * @file e437ea58 — agenfk config get/set covers every server setting.
 *
 * `agenfk config set` knew two local keys (telemetry, flowRegistry). The
 * server's settings (the board's Settings screen, e.g. maxConcurrentSuiteRuns)
 * had no CLI at all. Now any key GET /settings reports is set by name, its
 * value read by the setting's own type, and the server validates it: its
 * error is printed and the command exits non-zero. A setting added later
 * needs no new command. telemetry and flowRegistry keep their local meaning.
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
  setTelemetryEnabled: vi.fn(),
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
import { setTelemetryEnabled } from '@agenfk/telemetry';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';
const PROJECT = '33333333-3333-3333-3333-333333333333';

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



const SETTINGS = { tmuxByDefault: false, attentionAlerts: true, soundTiming: 'unfocused', maxConcurrentSuiteRuns: 0 };
const puts = () => mockedAxios.put.mock.calls.filter(c => String(c[0]).endsWith('/settings'));

describe('agenfk config set <server setting>', () => {
  it('sets a number setting through PUT /settings, as a number', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    mockedAxios.put.mockResolvedValue({ data: { ...SETTINGS, maxConcurrentSuiteRuns: 4 } });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'maxConcurrentSuiteRuns', '4']);
    expect(puts()).toEqual([[`${API}/settings`, { maxConcurrentSuiteRuns: 4 }]]);
    expect(outputText()).toMatch(/maxConcurrentSuiteRuns.*4/);
  });

  it('reads a boolean as true/false', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    mockedAxios.put.mockResolvedValue({ data: { ...SETTINGS, attentionAlerts: false } });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'attentionAlerts', 'false']);
    expect(puts()[0][1]).toEqual({ attentionAlerts: false });
  });

  it('keeps a text setting as text', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    mockedAxios.put.mockResolvedValue({ data: { ...SETTINGS, soundTiming: 'always' } });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'soundTiming', 'always']);
    expect(puts()[0][1]).toEqual({ soundTiming: 'always' });
  });

  it('refuses a value of the wrong type before sending anything', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'maxConcurrentSuiteRuns', 'lots']);
    expect(puts()).toEqual([]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("prints the server's refusal and exits non-zero", async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    mockedAxios.put.mockRejectedValue({ response: { status: 400, data: { error: 'Setting "maxConcurrentSuiteRuns" cannot be -1.' } } });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'maxConcurrentSuiteRuns', '-1']);
    expect(outputText()).toMatch(/cannot be -1/);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('refuses an unknown key, naming the ones it knows', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'noSuchSetting', '1']);
    expect(puts()).toEqual([]);
    expect(outputText()).toMatch(/maxConcurrentSuiteRuns/);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('telemetry keeps its local meaning: written on this machine, nothing sent to the server', async () => {
    await program.parseAsync(['node', 'agenfk', 'config', 'set', 'telemetry', 'false']);
    expect(puts()).toEqual([]);
    expect(vi.mocked(setTelemetryEnabled)).toHaveBeenCalledWith(false);
  });
});

describe('agenfk config get', () => {
  it('prints every server setting', async () => {
    mockedAxios.get.mockResolvedValue({ data: SETTINGS });
    await program.parseAsync(['node', 'agenfk', 'config', 'get']);
    expect(outputText()).toMatch(/maxConcurrentSuiteRuns/);
    expect(outputText()).toMatch(/soundTiming/);
  });

  it('prints one setting by name', async () => {
    mockedAxios.get.mockResolvedValue({ data: { ...SETTINGS, maxConcurrentSuiteRuns: 3 } });
    await program.parseAsync(['node', 'agenfk', 'config', 'get', 'maxConcurrentSuiteRuns']);
    expect(logSpy.mock.calls.map(c => c.join(' '))).toContain('3');
  });
});
