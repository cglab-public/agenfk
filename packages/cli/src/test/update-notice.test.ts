/**
 * b60bc8bf (CGLAB-164): bare `agenfk` offered an OLDER stable as an update.
 *
 * On 2.0.0-beta.12 it printed "Update available: 1.1.20": the notice asked only
 * the stable channel and fired whenever the versions differed. It now compares
 * against the newest release the user's channel can reach - the latest stable,
 * and on a prerelease also the latest beta - fires only for a strictly newer
 * one, and names the command that installs it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('no gh'); }),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { updateNotice, findUpdateNotice } from '../updateNotice';
import { program, fetchLatestReleaseTag } from '../index';
import axios from 'axios';

describe('updateNotice: which release, if any, to offer', () => {
  it('on a beta, never offers an older stable (the reported case)', () => {
    expect(updateNotice('2.0.0-beta.12', { stable: '1.1.20', beta: '2.0.0-beta.12' })).toBeNull();
  });

  it('on a beta, offers a newer beta, with the --beta command', () => {
    expect(updateNotice('2.0.0-beta.12', { stable: '1.1.20', beta: '2.0.0-beta.13' }))
      .toEqual({ version: '2.0.0-beta.13', command: 'agenfk upgrade --beta' });
  });

  it('on a beta, offers the stable that graduates it, with the plain command', () => {
    expect(updateNotice('2.0.0-beta.12', { stable: '2.0.0', beta: '2.0.0-beta.12' }))
      .toEqual({ version: '2.0.0', command: 'agenfk upgrade' });
  });

  it('on a beta, offers whichever of the two is newer', () => {
    expect(updateNotice('2.0.0-beta.12', { stable: '2.0.0', beta: '2.1.0-beta.1' }))
      .toEqual({ version: '2.1.0-beta.1', command: 'agenfk upgrade --beta' });
  });

  it('compares prerelease numbers numerically (beta.10 is newer than beta.9)', () => {
    expect(updateNotice('2.0.0-beta.9', { beta: '2.0.0-beta.10' }))
      .toEqual({ version: '2.0.0-beta.10', command: 'agenfk upgrade --beta' });
  });

  it('on a stable, offers a newer stable and never a beta', () => {
    expect(updateNotice('1.1.20', { stable: '1.1.21', beta: '2.0.0-beta.12' }))
      .toEqual({ version: '1.1.21', command: 'agenfk upgrade' });
    expect(updateNotice('1.1.20', { stable: '1.1.20', beta: '2.0.0-beta.12' })).toBeNull();
  });

  it('on a stable, never offers a beta that GitHub reports as the latest stable (published without --prerelease)', () => {
    expect(updateNotice('1.1.20', { stable: '2.0.0-beta.13' })).toBeNull();
  });

  it('offers nothing when nothing is known, or a version cannot be read', () => {
    expect(updateNotice('2.0.0-beta.12', {})).toBeNull();
    expect(updateNotice('2.0.0-beta.12', { stable: 'hub-v1.2.0', beta: 'garbage' })).toBeNull();
  });
});

describe('findUpdateNotice: which channels it asks', () => {
  it('on a beta, asks both channels and offers the newer beta', async () => {
    const asked: boolean[] = [];
    const notice = await findUpdateNotice('2.0.0-beta.12', async (beta) => { asked.push(beta); return beta ? 'v2.0.0-beta.13' : 'v1.1.20'; });
    expect(asked.sort()).toEqual([false, true]);
    expect(notice).toEqual({ version: '2.0.0-beta.13', command: 'agenfk upgrade --beta' });
  });

  it('on a stable, never asks the beta channel', async () => {
    const asked: boolean[] = [];
    await findUpdateNotice('1.1.20', async (beta) => { asked.push(beta); return 'v1.1.21'; });
    expect(asked).toEqual([false]);
  });

  it('one channel failing does not hide the other', async () => {
    const notice = await findUpdateNotice('2.0.0-beta.12', async (beta) => {
      if (!beta) throw new Error('rate limited');
      return 'v2.0.0-beta.13';
    });
    expect(notice).toEqual({ version: '2.0.0-beta.13', command: 'agenfk upgrade --beta' });
  });
});

describe('the latest beta is the newest VERSION, not the newest publish date', () => {
  const mockedAxios = vi.mocked(axios, true);
  afterEach(() => mockedAxios.get.mockReset());

  it('a hotfix beta for an older line, published later, is not "the latest beta"', async () => {
    mockedAxios.get.mockResolvedValue({ data: [
      { tag_name: 'v1.1.21-beta.1', prerelease: true, published_at: '2026-09-30T12:00:00Z' },
      { tag_name: 'v2.0.0-beta.13', prerelease: true, published_at: '2026-09-29T12:00:00Z' },
      { tag_name: 'v1.1.20', prerelease: false, published_at: '2026-09-01T12:00:00Z' },
    ] } as any);
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', true)).toBe('v2.0.0-beta.13');
  });
});

describe('bare `agenfk` prints the notice updateNotice decides', () => {
  const mockedAxios = vi.mocked(axios, true);
  let out: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  /** GitHub's release endpoints, answering with the given stable and prerelease tags. */
  function releases(stable: string, beta: string) {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (/\/releases\/latest$/.test(url)) return { data: { tag_name: stable } } as any;
      if (/\/releases\?per_page=/.test(url)) {
        return { data: [
          { tag_name: beta, prerelease: true, published_at: '2026-09-29T12:00:00Z' },
          { tag_name: stable, prerelease: false, published_at: '2026-09-01T12:00:00Z' },
        ] } as any;
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  async function runBare(): Promise<string[]> {
    try { await program.parseAsync(['node', 'agenfk']); } catch (e: any) { if (e?.message !== 'exit') throw e; }
    return out.join('\n').split('\n').filter((l) => /Update available|agenfk upgrade/.test(l));
  }

  beforeEach(() => {
    out = [];
    // eslint-disable-next-line no-control-regex
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { out.push(a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '')); });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => { logSpy.mockRestore(); exitSpy.mockRestore(); writeSpy.mockRestore(); mockedAxios.get.mockReset(); });

  it('says nothing when every release is older than this one', async () => {
    releases('v0.0.1', 'v0.0.1-beta.1');
    expect(await runBare()).toEqual([]);
  });

  it('offers a newer stable, and the command to get it', async () => {
    releases('v99.0.0', 'v0.0.1-beta.1');
    expect(await runBare()).toEqual([
      expect.stringMatching(/^Update available: 99\.0\.0 \(current: .+\)$/),
      "Run 'agenfk upgrade' to update.",
    ]);
  });
});
