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
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

const FULL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('verify command', () => {
  function resetCommanderOptions(cmd: any) {
    (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
    (cmd.commands || []).forEach(resetCommanderOptions);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    program.commands.forEach(resetCommanderOptions);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('test-token');
  });

  it('should be registered as a command', () => {
    expect(program.commands.map(c => c.name())).toContain('verify');
  });

  it('review and test commands should not exist', () => {
    const names = program.commands.map(c => c.name());
    expect(names).not.toContain('review');
    expect(names).not.toContain('test');
  });

  it('should POST evidence to /validate without GET or PUT', async () => {
    mockedAxios.post.mockResolvedValue({ data: { message: '✅ Validation Passed!\n\nItem moved to REVIEW.' } });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'All tests pass']);

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${FULL_ID}/validate`),
      expect.objectContaining({ evidence: 'All tests pass' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-agenfk-internal': 'test-token' }) })
    );
    logSpy.mockRestore();
  });

  it('should pass optional command alongside evidence to /validate', async () => {
    mockedAxios.post.mockResolvedValue({ data: { message: '✅ Validation Passed!\n\nItem moved to DONE.' } });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'Done', 'npm test']);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${FULL_ID}/validate`),
      expect.objectContaining({ evidence: 'Done', command: 'npm test' }),
      expect.any(Object)
    );
    logSpy.mockRestore();
  });

  it('should resolve short IDs', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: FULL_ID, title: 'Task' }] });
    mockedAxios.post.mockResolvedValue({ data: { message: '✅ Validation Passed!' } });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'verify', 'aaaaaaaa', '--evidence', 'done']);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${FULL_ID}/validate`),
      expect.any(Object),
      expect.any(Object)
    );
    logSpy.mockRestore();
  });

  it('should error when --evidence is missing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID]);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--evidence'));
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should error when verify-token file is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'done']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('verify-token'));
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
