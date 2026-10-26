/**
 * @file GH-288 — `agenfk db status` shows what the database file holds, and
 * `agenfk db vacuum` asks the server (which owns the file) to compact it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn(), mockReadFileSync: vi.fn() }));

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

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const run = (...args: string[]) => program.parseAsync(['node', 'agenfk', ...args]);
const MB = 1024 * 1024;
const printed = () => vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n');
const printedErr = () => vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');

describe('agenfk db status (GH-288)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
  });

  it('shows the file, the WAL, what a vacuum would reclaim, and with --tables the largest tables', async () => {
    mockedAxios.get.mockResolvedValue({ data: {
      dbType: 'sqlite', dbPath: '/h/db.sqlite', backupDir: '/h/backup', backupCount: 1, latestBackup: 'b',
      size: { fileBytes: 373 * MB, walBytes: 1 * MB, reclaimableBytes: 120 * MB, tables: [
        { name: 'step_results', bytes: 200 * MB }, { name: 'items', bytes: 100 * MB }, { name: 'events', bytes: 10 * MB },
      ] },
    } });
    await run('db', 'status', '--tables');
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringMatching(/\/db\/status\?tables=1$/));
    const out = printed();
    expect(out).toMatch(/Size:\s+373(\.0)? MB/);
    expect(out).toMatch(/WAL:\s+1(\.0)? MB/);
    expect(out).toMatch(/Reclaimable:\s+120(\.0)? MB.*agenfk db vacuum/);
    expect(out.indexOf('step_results')).toBeLessThan(out.indexOf('items'));
    expect(out).toMatch(/step_results\s+200(\.0)? MB/);
  });
});

describe('agenfk db status, a failed backup (GH-288)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
  });

  it('says so, with when and why', async () => {
    mockedAxios.get.mockResolvedValue({ data: {
      dbType: 'sqlite', dbPath: '/h/db.sqlite', backupDir: '/h/backup', backupCount: 1, latestBackup: 'b',
      lastBackupError: { at: '2026-10-26T18:00:00.000Z', error: 'disk full' },
      size: { fileBytes: 1, walBytes: 0, reclaimableBytes: 0, tables: [] },
    } });
    await run('db', 'status');
    expect(printed()).toMatch(/backup FAILED at 2026-10-26T18:00:00.000Z: disk full/);
  });

  it('says nothing about failure when the last backup worked', async () => {
    mockedAxios.get.mockResolvedValue({ data: {
      dbType: 'sqlite', dbPath: '/h/db.sqlite', backupDir: '/h/backup', backupCount: 1, latestBackup: 'b', lastBackupError: null,
      size: { fileBytes: 1, walBytes: 0, reclaimableBytes: 0, tables: [] },
    } });
    await run('db', 'status');
    expect(printed()).not.toMatch(/FAILED/);
  });
});

describe('agenfk db vacuum (GH-288)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('verify-token'));
    mockReadFileSync.mockImplementation((p: string) => (String(p).endsWith('verify-token') ? 'tok-123\n' : '{}'));
  });

  it('asks the server with the internal token and prints the size before and after', async () => {
    mockedAxios.post.mockResolvedValue({ data: {
      check: 'ok',
      before: { fileBytes: 562 * MB, walBytes: 247 * MB, reclaimableBytes: 190 * MB },
      after: { fileBytes: 373 * MB, walBytes: 0, reclaimableBytes: 0 },
    } });
    await run('db', 'vacuum');
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringMatching(/\/db\/vacuum$/), {}, expect.objectContaining({
      headers: { 'x-agenfk-internal': 'tok-123' },
    }));
    const out = printed();
    expect(out).toMatch(/809(\.0)? MB.*373(\.0)? MB/);
    expect(out).toMatch(/integrity.*ok/i);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('names the cards whose suite runs are in flight when the server refuses, and fails', async () => {
    mockedAxios.post.mockRejectedValue(Object.assign(new Error('409'), { response: { status: 409, data: {
      error: 'A verify suite run is in progress (card-a, card-b): vacuum when it finishes.', running: ['card-a', 'card-b'],
    } } }));
    await run('db', 'vacuum');
    expect(printedErr()).toMatch(/card-a.*card-b/);
    expect(process.exitCode).toBe(1);
  });

  it('fails when the integrity check after the vacuum is not ok', async () => {
    mockedAxios.post.mockResolvedValue({ data: {
      check: '*** in database main ***\nPage 5 is never used',
      before: { fileBytes: 10 * MB, walBytes: 0, reclaimableBytes: 0 }, after: { fileBytes: 10 * MB, walBytes: 0, reclaimableBytes: 0 },
    } });
    await run('db', 'vacuum');
    expect(printedErr()).toMatch(/Page 5 is never used/);
    expect(process.exitCode).toBe(1);
  });
});
