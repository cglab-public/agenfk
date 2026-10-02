/**
 * 658ef023: `agenfk upgrade` extracts the published build into the directory
 * the CLI runs from. When `agenfk` is a symlink into a development checkout,
 * that directory IS the checkout: on 2026-09-29 an upgrade to 2.0.0-beta.10
 * rewrote 28 tracked files and every dist, and the server came back as a
 * different version from the branch being worked on.
 *
 * These run the real command from this repository - a git checkout - so the
 * refusal is what they must see: before any network, any `down`, any `tar`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
const execSync = vi.fn(() => '');
vi.mock('child_process', () => ({
  execSync: (...a: unknown[]) => execSync(...(a as [])),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
let out: string[];
let spies: Array<{ mockRestore: () => void }>;

beforeEach(() => {
  out = [];
  // eslint-disable-next-line no-control-regex
  const capture = (...a: any[]) => { out.push(a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '')); };
  spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as any),
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any),
  ];
  execSync.mockClear();
  mockedAxios.get.mockResolvedValue({ data: {} } as any);
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  mockedAxios.get.mockReset();
});

async function upgrade(...args: string[]) {
  try { await program.parseAsync(['node', 'agenfk', 'upgrade', ...args]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}

describe('agenfk upgrade from a development checkout', () => {
  it('this test runs from one: the repository root holds .git', () => {
    // The premise of the cases below; if it ever stops holding they would pass for the wrong reason.
    expect(fs.existsSync(path.resolve(__dirname, '../../../../.git'))).toBe(true);
  });

  it('refuses, and says how a checkout is updated', async () => {
    const text = await upgrade('--version', '9.9.9');
    expect(text).toMatch(/development checkout/i);
    expect(text).toMatch(/git pull/);
  });

  it('touches nothing: no services stopped, no archive extracted', async () => {
    await upgrade('--version', '9.9.9', '--force');
    const commands = execSync.mock.calls.map(c => String((c as unknown[])[0]));
    expect(commands.filter(c => /\btar\b|\bdown\b|install\.mjs|npm (ci|install)/.test(c))).toEqual([]);
  });

  it('answers --json with failed, so the fleet reconciler records it and does not self-extract over it', async () => {
    const text = await upgrade('--version', '9.9.9', '--json');
    const line = text.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
    expect(line, text).toBeTruthy();
    const json = JSON.parse(line!);
    expect(json.status).toBe('failed');
    expect(json.error).toMatch(/development checkout/i);
  });
});
