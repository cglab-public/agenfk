/**
 * What the CLI does with an upgrade tier, by behaviour (replaces the source
 * scans in upgrade-tier.test.ts).
 *
 * - mandatory, and newer than this install: says so on stderr, names
 *   `agenfk upgrade`, and exits 1 - before any command runs.
 * - recommended, and newer: a banner on stderr only. stdout stays clean, so
 *   `agenfk list --json | jq` is never corrupted. No exit.
 * - optional, or a version that is not newer: silent.
 * - a cache younger than an hour answers without the network; an older one
 *   is fetched again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) { this.capture = vi.fn(); this.shutdown = vi.fn().mockResolvedValue(undefined); this.isEnabled = false; }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import * as os from 'os';
import axios from 'axios';
import { checkUpgradeTier } from '../index';

const mockedAxios = vi.mocked(axios, true);
const NEWER = '999.0.0';
const OLDER = '0.0.1';
let home: string;
let errors: string[];
let logs: string[];
let stdoutWrites: string[];
let exit: ReturnType<typeof vi.spyOn>;

const cacheFile = () => path.join(home, '.agenfk', 'upgrade-tier-cache.json');
function seedCache(tier: string, version: string, ageMs = 0) {
  fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify({ tier, version, fetchedAt: Date.now() - ageMs }));
}
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agenfk-tier-action-'));
  vi.mocked(os.homedir).mockReturnValue(home);
  errors = []; logs = []; stdoutWrites = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(plain(a.join(' '))); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(plain(a.join(' '))); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdoutWrites.push(String(chunk)); return true; }) as any);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  mockedAxios.get.mockRejectedValue(new Error('no network in this test'));
});
afterEach(() => {
  vi.restoreAllMocks();
  mockedAxios.get.mockReset();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a mandatory upgrade', () => {
  it('exits 1, naming the version and `agenfk upgrade` on stderr', async () => {
    seedCache('mandatory', NEWER);
    await checkUpgradeTier();
    expect(exit).toHaveBeenCalledWith(1);
    const said = errors.join('\n');
    expect(said).toMatch(/mandatory/i);
    expect(said).toContain(`v${NEWER}`);
    expect(said).toContain('agenfk upgrade');
  });

  it('writes nothing to stdout', async () => {
    seedCache('mandatory', NEWER);
    await checkUpgradeTier();
    expect(logs).toEqual([]);
    expect(stdoutWrites).toEqual([]);
  });

  it('does not block when the advertised version is not newer than this install', async () => {
    seedCache('mandatory', OLDER);
    await checkUpgradeTier();
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

describe('a recommended upgrade', () => {
  it('prints a banner naming the version and `agenfk upgrade` on stderr, and does not exit', async () => {
    seedCache('recommended', NEWER);
    await checkUpgradeTier();
    expect(exit).not.toHaveBeenCalled();
    const said = errors.join('\n');
    expect(said).toMatch(/recommended/i);
    expect(said).toContain(`v${NEWER}`);
    expect(said).toContain('agenfk upgrade');
  });

  it('leaves stdout untouched, so machine-readable output stays parseable', async () => {
    seedCache('recommended', NEWER);
    await checkUpgradeTier();
    expect(logs).toEqual([]);
    expect(stdoutWrites).toEqual([]);
  });

  it('is silent when the advertised version is not newer than this install', async () => {
    seedCache('recommended', OLDER);
    await checkUpgradeTier();
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe('an optional upgrade', () => {
  it('is silent and does not exit', async () => {
    seedCache('optional', NEWER);
    await checkUpgradeTier();
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
    expect(stdoutWrites).toEqual([]);
  });
});

describe('the tier cache', () => {
  it('answers from a cache younger than an hour without asking the network', async () => {
    seedCache('recommended', NEWER, 59 * 60 * 1000);
    await checkUpgradeTier();
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/recommended/i);
  });

  it('asks again once the cache is older than an hour, and rewrites it', async () => {
    seedCache('mandatory', NEWER, 61 * 60 * 1000);
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('localhost')) return { data: { tagName: `v${OLDER}`, upgradeTier: 'optional' } };
      throw new Error(`unexpected GET ${url}`);
    });
    await checkUpgradeTier();
    expect(mockedAxios.get).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(cached).toMatchObject({ tier: 'optional', version: OLDER });
    expect(Date.now() - cached.fetchedAt).toBeLessThan(60_000);
  });
});

/*
 * The startup wiring: the check runs before commander parses, so a mandatory
 * tier blocks every command. Needs the built CLI (CI builds before testing).
 */
describe('the CLI at startup', () => {
  const bin = path.resolve(__dirname, '../../dist/index.js');

  it.skipIf(!fs.existsSync(bin))('a fresh mandatory cache stops a command before it runs', () => {
    const realOs = require('os') as typeof import('os');
    const sandbox = fs.mkdtempSync(path.join(realOs.tmpdir(), 'agenfk-tier-startup-'));
    try {
      fs.mkdirSync(path.join(sandbox, '.agenfk'), { recursive: true });
      fs.writeFileSync(path.join(sandbox, '.agenfk', 'upgrade-tier-cache.json'),
        JSON.stringify({ tier: 'mandatory', version: NEWER, fetchedAt: Date.now() }));
      const r = spawnSync(process.execPath, [bin, 'list-projects', '--json'], {
        encoding: 'utf8',
        timeout: 30_000,
        // Port 9 refuses at once: if the command ran anyway it would fail fast, never reach a real server.
        env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, NODE_ENV: 'production', AGENFK_API_URL: 'http://127.0.0.1:9', AGENFK_TELEMETRY: 'false' },
      });
      expect(r.status, r.stderr).toBe(1);
      expect(plain(r.stderr)).toMatch(/MANDATORY UPGRADE REQUIRED/);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
