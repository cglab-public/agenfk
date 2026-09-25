/**
 * `agenfk update-project --test-report-*` (9afdba7d).
 *
 * The test report's `surface` - test paths the runner's report cannot name -
 * is what test-surface-frozen tells a blocked user to set, so the CLI must be
 * able to set it. And the server's PUT replaces the whole setting, so the CLI
 * merges the flags it was given onto the stored setting: changing the command
 * must not drop the surface, or the format and path.
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
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
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


const TOKEN = 'tok';
const stored = { format: 'junit-xml', command: 'npm test', reportPath: 'junit.xml', surface: ['helpers'] };
function withToken() {
  mockExistsSync.mockImplementation((p: any) => String(p).endsWith('verify-token'));
  mockReadFileSync.mockImplementation((p: any) => (String(p).endsWith('verify-token') ? TOKEN : '{}'));
}
const sentTestReport = () => mockedAxios.put.mock.calls.find(c => String(c[0]).endsWith('/test-report'));

describe('agenfk update-project --test-report-surface', () => {
  it('exposes the option', () => {
    const cmd = program.commands.find(c => c.name() === 'update-project');
    expect((cmd as any).options.map((o: any) => o.long)).toContain('--test-report-surface');
  });

  it('sets the surface, keeping the stored format, command and path', async () => {
    withToken();
    mockedAxios.get.mockResolvedValue({ data: { id: PROJECT, testReport: stored } });
    mockedAxios.put.mockResolvedValue({ data: { id: PROJECT } });
    await program.parseAsync(['node', 'agenfk', 'update-project', PROJECT, '--test-report-surface', 'Calc.UnitTests, checks']);
    const call = sentTestReport();
    expect(call?.[0]).toBe(`${API}/projects/${PROJECT}/test-report`);
    expect(call?.[1]).toEqual({ format: 'junit-xml', command: 'npm test', reportPath: 'junit.xml', surface: ['Calc.UnitTests', 'checks'] });
    expect(call?.[2]).toEqual({ headers: { 'x-agenfk-internal': TOKEN } });
  });

  it('changing the command keeps the stored surface', async () => {
    withToken();
    mockedAxios.get.mockResolvedValue({ data: { id: PROJECT, testReport: stored } });
    mockedAxios.put.mockResolvedValue({ data: { id: PROJECT } });
    await program.parseAsync(['node', 'agenfk', 'update-project', PROJECT, '--test-report-command', 'npm run test:ci']);
    expect(sentTestReport()?.[1]).toEqual({ ...stored, command: 'npm run test:ci' });
  });

  it('"none" clears the surface only', async () => {
    withToken();
    mockedAxios.get.mockResolvedValue({ data: { id: PROJECT, testReport: stored } });
    mockedAxios.put.mockResolvedValue({ data: { id: PROJECT } });
    await program.parseAsync(['node', 'agenfk', 'update-project', PROJECT, '--test-report-surface', 'none']);
    expect(sentTestReport()?.[1]).toEqual({ format: 'junit-xml', command: 'npm test', reportPath: 'junit.xml' });
  });

  it('a surface with no test report to add it to is refused before anything is sent', async () => {
    withToken();
    mockedAxios.get.mockResolvedValue({ data: { id: PROJECT } });
    await program.parseAsync(['node', 'agenfk', 'update-project', PROJECT, '--test-report-surface', 'checks']);
    expect(sentTestReport()).toBeUndefined();
    expect(outputText()).toMatch(/--test-report-format/);
  });

  it('refuses clearing the report and setting a surface in one go', async () => {
    withToken();
    mockedAxios.get.mockResolvedValue({ data: { id: PROJECT, testReport: stored } });
    await program.parseAsync(['node', 'agenfk', 'update-project', PROJECT, '--test-report', 'none', '--test-report-surface', 'checks']);
    expect(sentTestReport()).toBeUndefined();
    expect(outputText()).toMatch(/--test-report none/);
  });
});
