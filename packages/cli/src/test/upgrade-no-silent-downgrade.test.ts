/**
 * BUG 3a261573: on 2.0.0-beta.12, plain `agenfk upgrade` installed 1.1.20.
 * The only skip was target === current, so the stable channel's answer was
 * installed whatever its version. And the stable answer came from GitHub's
 * /releases/latest, which picks by DATE: a 1.1.21 hotfix published after 2.0.0
 * would be "latest", and `upgrade` on 2.0.0 would downgrade to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
const { execSync, execFileSync, spawnSync } = vi.hoisted(() => ({
  execSync: vi.fn(), execFileSync: vi.fn(), spawnSync: vi.fn(() => ({ status: 0 })),
}));
vi.mock('child_process', () => ({
  execSync, execFileSync, spawnSync, spawn: vi.fn(),
  default: { execSync, execFileSync, spawnSync, spawn: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
// This test runs from a checkout, which `upgrade` refuses to write over
// (658ef023, its own test). Hide the .git so the decision under test is reached.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = (p: any) => (String(p).endsWith(`${path.sep}.git`) ? false : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import axios from 'axios';
import { program, fetchLatestReleaseTag } from '../index';
import { isUpgrade } from '@agenfk/core';

const CURRENT = (require('../../package.json') as { version: string }).version;
const mockedAxios = vi.mocked(axios, true);
let out: string[];
let spies: Array<{ mockRestore: () => void }>;

/** GitHub as `upgrade` sees it: services down, then the release lookups. */
function github(opts: { latest: string; list: Array<{ tag: string; pre?: boolean; at?: string }> }) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.includes('localhost')) throw new Error('services down');
    if (url.endsWith('/releases/latest')) return { data: { tag_name: opts.latest } };
    if (url.includes('/releases/tags/')) return { status: 200, data: { tag_name: decodeURIComponent(url.split('/releases/tags/')[1]) } };
    if (url.includes('/releases?')) {
      return { data: opts.list.map(r => ({ tag_name: r.tag, prerelease: !!r.pre, published_at: r.at ?? '2026-09-01T00:00:00Z' })) };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

async function upgrade(...args: string[]) {
  try { await program.parseAsync(['node', 'agenfk', 'upgrade', ...args]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}
const extracted = () => execSync.mock.calls.some(c => /\btar\b/.test(String(c[0])));

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
  execSync.mockReset();
  execFileSync.mockReset();
  // commander keeps option values on the command between parses: a --json or
  // --force from one test would otherwise still be set in the next.
  const cmd = program.commands.find(c => c.name() === 'upgrade')!;
  for (const o of cmd.options) cmd.setOptionValue(o.attributeName(), undefined);
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  mockedAxios.get.mockReset();
});

describe('upgrade never downgrades without being asked (BUG 3a261573)', () => {
  it('the premise: this CLI is on a version newer than 1.1.20', () => {
    expect(isUpgrade(CURRENT, '1.1.20')).toBe(true);
  });

  it('refuses when the latest stable is older than what is installed, and says --beta', async () => {
    github({ latest: 'v1.1.20', list: [{ tag: 'v1.1.20' }] });
    const text = await upgrade();
    expect(text).toMatch(/1\.1\.20/);
    expect(text).toMatch(/--beta/);
    expect(text).not.toMatch(/Upgrading AgEnFK/);
    expect(extracted(), 'an archive was extracted').toBe(false);
  });

  it('answers --json with noop, so the fleet reconciler does not count it a failure', async () => {
    github({ latest: 'v1.1.20', list: [{ tag: 'v1.1.20' }] });
    const line = (await upgrade('--json')).split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
    expect(JSON.parse(line!)).toMatchObject({ status: 'noop', fromVersion: CURRENT, toVersion: '1.1.20' });
  });

  it('does NOT downgrade with --force, which only reinstalls (the shipped /agenfk-upgrade passed it every run)', async () => {
    github({ latest: 'v1.1.20', list: [{ tag: 'v1.1.20' }] });
    const text = await upgrade('--force');
    expect(text).toMatch(/not downgrading/);
    expect(text).not.toMatch(/Upgrading AgEnFK/);
    expect(extracted()).toBe(false);
  });

  it('--force still reinstalls the version already installed', async () => {
    github({ latest: `v${CURRENT}`, list: [{ tag: `v${CURRENT}`, pre: CURRENT.includes('-') }] });
    const text = await upgrade('--force', ...(CURRENT.includes('-') ? ['--beta'] : []));
    expect(text).toMatch(/Reinstalling AgEnFK/);
  });

  it('goes ahead with --version, which names the release on purpose', async () => {
    github({ latest: 'v1.1.20', list: [{ tag: 'v1.1.20' }] });
    const text = await upgrade('--version', '1.1.20');
    expect(text).toMatch(/Upgrading AgEnFK .* → 1\.1\.20/);
  });

  // These two describe a beta install: true for this repo except on the commit
  // that bumps to a stable, where they would otherwise go red for no defect.
  it.runIf(CURRENT.includes('-'))('the stable-channel refusal points a beta install at --beta, and --beta does not repeat it', async () => {
    github({ latest: 'v1.1.20', list: [{ tag: 'v1.1.20' }, { tag: 'v1.1.20-beta.1', pre: true }] });
    expect(await upgrade()).toMatch(/on the beta line: agenfk upgrade --beta/);
    out.length = 0;
    expect(await upgrade('--beta')).not.toMatch(/on the beta line/);
  });

  it.runIf(CURRENT.includes('-'))('--beta takes the stable that graduates the beta when no newer beta exists', async () => {
    const [core] = CURRENT.split('-');
    github({ latest: `v${core}`, list: [{ tag: `v${core}` }, { tag: `v${CURRENT}`, pre: true }] });
    const text = await upgrade('--beta');
    expect(text).toMatch(new RegExp(`Upgrading AgEnFK .* → ${core.replace(/\./g, '\\.')}\\.\\.\\.`));
  });

  it('--beta falls back to stable when no beta is listed at all', async () => {
    github({ latest: 'v99.0.0', list: [{ tag: 'v99.0.0' }] });
    expect(await upgrade('--beta')).toMatch(/Upgrading AgEnFK .* → 99\.0\.0/);
  });

  it('still upgrades to a newer release', async () => {
    github({ latest: 'v99.0.0', list: [{ tag: 'v99.0.0' }] });
    const text = await upgrade();
    expect(text).toMatch(/Upgrading AgEnFK .* → 99\.0\.0/);
  });
});

describe('the stable channel picks by version, not by date (BUG 3a261573)', () => {
  it('a hotfix on an older line published after the newer stable does not win', async () => {
    github({
      latest: 'v1.1.21', // newest by date: a hotfix of the 1.1 line
      list: [
        { tag: 'v1.1.21', at: '2026-10-05T00:00:00Z' },
        { tag: 'v2.0.0', at: '2026-10-01T00:00:00Z' },
        { tag: 'v2.0.1-beta.1', pre: true, at: '2026-10-06T00:00:00Z' },
      ],
    });
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v2.0.0');
  });

  it("keeps GitHub's latest when the list holds no stable at all (a long beta run)", async () => {
    github({
      latest: 'v1.1.20',
      list: Array.from({ length: 23 }, (_, i) => ({ tag: `v2.0.0-beta.${i + 1}`, pre: true })),
    });
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v1.1.20');
  });

  it('asks for a page long enough to reach past a long beta run', async () => {
    github({ latest: 'v1.1.20', list: [] });
    await fetchLatestReleaseTag('cglab-public/agenfk', false);
    const listCall = mockedAxios.get.mock.calls.map(c => String(c[0])).find(u => u.includes('/releases?'));
    expect(listCall).toMatch(/per_page=100/);
  });

  it('the gh fallback applies the same rule', async () => {
    mockedAxios.get.mockRejectedValue(new Error('api down'));
    execFileSync
      .mockReturnValueOnce('v1.1.21' as any) // `gh release view`: newest by date
      .mockReturnValueOnce(JSON.stringify([
        { tagName: 'v1.1.21', isPrerelease: false, createdAt: '2026-10-05T00:00:00Z' },
        { tagName: 'v2.0.0', isPrerelease: false, createdAt: '2026-10-01T00:00:00Z' },
      ]) as any);
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v2.0.0');
    const listArgs = execFileSync.mock.calls.map(c => (c[1] as string[]).join(' ')).find(a => a.startsWith('release list'));
    expect(listArgs).toMatch(/--limit 100/);
  });

  it('a failed list request keeps the good /releases/latest answer', async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/releases/latest')) return { data: { tag_name: 'v2.0.0' } };
      throw new Error('rate limited');
    });
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v2.0.0');
  });

  it('gh fallback: the viewed tag counts when the list holds no stable, and survives a failed list', async () => {
    mockedAxios.get.mockRejectedValue(new Error('api down'));
    execFileSync
      .mockReturnValueOnce('v1.1.20' as any)
      .mockReturnValueOnce(JSON.stringify([{ tagName: 'v2.0.0-beta.23', isPrerelease: true, createdAt: '2026-10-02T00:00:00Z' }]) as any);
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v1.1.20');
    execFileSync.mockReset();
    execFileSync
      .mockReturnValueOnce('v1.1.20' as any)
      .mockImplementationOnce(() => { throw new Error('gh timed out'); });
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v1.1.20');
  });

  it('stable never takes a beta published without --prerelease', async () => {
    github({ latest: 'v2.0.1', list: [{ tag: 'v2.1.0-beta.1', pre: false }, { tag: 'v2.0.1' }] });
    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v2.0.1');
  });
});
