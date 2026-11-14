/**
 * @file CGLAB-457 (T2) — `agenfk review brief <id>` prints the brief the
 * server writes for the reviewer: its text, or its JSON with --json.
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
const mockInquirerPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => {
    cmd.setOptionValue(opt.attributeName(), undefined);
  });
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});



describe('agenfk review brief <id>', () => {
  const body = { itemId: 'item-1', step: 'REVIEW', range: { from: 'a', to: 'b' }, text: 'You are an independent reviewer.\nReview a..b.' };

  it('GETs /items/:id/review-brief and prints its text, ready to paste as the reviewer\'s prompt', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: body });
    await program.parseAsync(['node', 'agenfk', 'review', 'brief', 'item-1']);
    expect(mockedAxios.get).toHaveBeenCalledWith(`${API}/items/item-1/review-brief`);
    // A read: it moves nothing (verify stays the only forward move).
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toBe(body.text);
  });

  it('prints the whole brief as JSON with --json', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: body });
    await program.parseAsync(['node', 'agenfk', 'review', 'brief', 'item-1', '--json']);
    expect(JSON.parse(logSpy.mock.calls.flat().join('\n'))).toEqual(body);
  });

  it("prints the server's refusal and exits non-zero", async () => {
    mockedAxios.get.mockRejectedValue({ response: { status: 409, data: { error: 'WORK is not a review step' } } });
    await program.parseAsync(['node', 'agenfk', 'review', 'brief', 'item-1']);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('WORK is not a review step');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
