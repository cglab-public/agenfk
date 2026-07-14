/**
 * Tests for `agenfk current-project` — prints the project id resolved from the
 * nearest .agenfk/project.json (walking up from cwd). Bare output is the id
 * alone (script-friendly); --json adds server-side project details when the
 * server is reachable and degrades to { projectId } when it is not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

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
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync, writeFileSync: vi.fn(), mkdirSync: vi.fn() },
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

const PROJECT_ID = 'cd28943c-5216-40b8-8018-24baf306bc62';
const projectJsonPath = path.join(process.cwd(), '.agenfk', 'project.json');

function resetCommanderOptions(cmd: any) {
  ((cmd as any).options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

/** Make fs mocks expose a project.json in the cwd with the given content. */
function mockProjectJson(content: string) {
  mockExistsSync.mockImplementation((p: any) => String(p) === projectJsonPath);
  mockReadFileSync.mockImplementation((p: any) => {
    if (String(p) === projectJsonPath) return content;
    return '{}';
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  resetCommanderOptions(program);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

describe('current-project command', () => {
  it('is registered on the program', () => {
    const commands = program.commands.map(c => c.name());
    expect(commands).toContain('current-project');
  });

  it('prints the bare project id resolved from .agenfk/project.json', async () => {
    mockProjectJson(JSON.stringify({ projectId: PROJECT_ID }));

    await program.parseAsync(['node', 'agenfk', 'current-project']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain(PROJECT_ID);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    // Bare mode must not hit the server — it works offline.
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('errors and exits 1 when no .agenfk/project.json is found', async () => {
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(['node', 'agenfk', 'current-project']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errorSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(err.toLowerCase()).toContain('agenfk init');
  });

  it('errors and exits 1 when project.json is malformed', async () => {
    mockProjectJson('not-json{');

    await program.parseAsync(['node', 'agenfk', 'current-project']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--json includes server-side project details when reachable', async () => {
    mockProjectJson(JSON.stringify({ projectId: PROJECT_ID }));
    mockedAxios.get.mockResolvedValue({
      data: { id: PROJECT_ID, name: 'AgEnFK', description: 'The framework' },
    });

    await program.parseAsync(['node', 'agenfk', 'current-project', '--json']);

    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining(`/projects/${PROJECT_ID}`));
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.projectId).toBe(PROJECT_ID);
    expect(parsed.name).toBe('AgEnFK');
  });

  it('--json degrades to { projectId } when the server is unreachable', async () => {
    mockProjectJson(JSON.stringify({ projectId: PROJECT_ID }));
    mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'));

    await program.parseAsync(['node', 'agenfk', 'current-project', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.projectId).toBe(PROJECT_ID);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});
