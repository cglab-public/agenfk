/**
 * @file BUG b233143b (folded in by request) — the upgrade check must never
 * resolve a `hub-v*` tag as a framework version.
 *
 * Live incident: cutting `hub-v1.1.19-beta.1` (the hub-only Docker image line,
 * CGLAB-8) made `GET /releases/latest` return that tag, because `hub-image.yml`
 * creates hub releases without `--prerelease` — so a hub BETA was published as a
 * STABLE release, and `/releases/latest` only skips prereleases. Every CLI
 * invocation then printed "AgEnFK vhub-v1.1.19-beta.1 is available — run agenfk
 * upgrade", and `agenfk upgrade` would have tried to install a hub tag.
 *
 * `release.yml` already guards against this for version math ("--match 'v*' so
 * hub-only tags (hub-v*) never feed the framework version math"). The upgrade
 * resolver had no equivalent guard — defense-in-depth was missing precisely
 * where the repo had already documented the hazard.
 *
 * Behaviour-based: the GitHub REST call and `gh` are mocked, the real
 * `fetchLatestReleaseTag` is driven.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  // The resolver shells out with execFileSync + an argv array now, so `repo`
  // cannot smuggle a shell command. The mock has to expose that name or the
  // fallback path would call undefined.
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import axios from 'axios';
import { execFileSync } from 'child_process';
import { fetchLatestReleaseTag } from '../index';

const mockedAxios = vi.mocked(axios, true);
const mockedExec = vi.mocked(execFileSync, true);

describe('fetchLatestReleaseTag ignores the hub-only release line (BUG b233143b)', () => {
  // clearAllMocks() drops call history but KEEPS implementations, so a
  // mockReturnValue from an earlier test leaks into a later one and reports a
  // failure that has nothing to do with the code under test.
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockReset();
    mockedExec.mockReset();
  });

  it('--beta skips a hub tag that is the newest prerelease of all', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        // Newest prerelease in the repo — but it is the HUB image, not the framework.
        { tag_name: 'hub-v1.1.19-beta.1', published_at: '2026-09-10T13:00:00Z', prerelease: true },
        { tag_name: 'v1.1.19-beta.1', published_at: '2026-09-10T12:00:00Z', prerelease: true },
        { tag_name: 'v1.1.18', published_at: '2026-09-08T00:00:00Z', prerelease: false },
      ],
    });

    expect(await fetchLatestReleaseTag('cglab-public/agenfk', true)).toBe('v1.1.19-beta.1');
  });

  it('stable channel recovers when /releases/latest hands back a hub tag', async () => {
    // This is exactly what happened in production: the hub beta was created
    // without --prerelease, so GitHub's "latest" stable WAS the hub tag.
    mockedAxios.get
      .mockResolvedValueOnce({ data: { tag_name: 'hub-v1.1.19-beta.1', prerelease: false } })
      .mockResolvedValueOnce({
        data: [
          { tag_name: 'hub-v1.1.19-beta.1', published_at: '2026-09-10T13:00:00Z', prerelease: false },
          { tag_name: 'v1.1.18', published_at: '2026-09-08T00:00:00Z', prerelease: false },
          { tag_name: 'v1.1.17', published_at: '2026-09-04T00:00:00Z', prerelease: false },
        ],
      });

    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v1.1.18');
  });

  it('gh CLI fallback (--beta) excludes hub tags too', async () => {
    mockedAxios.get.mockRejectedValue(new Error('api down')); // force the gh path
    mockedExec.mockReturnValue(JSON.stringify([
      { tagName: 'hub-v1.1.19-beta.1', isPrerelease: true, createdAt: '2026-09-10T13:00:00Z' },
      { tagName: 'v1.1.19-beta.1', isPrerelease: true, createdAt: '2026-09-10T12:00:00Z' },
    ]) as any);

    expect(await fetchLatestReleaseTag('cglab-public/agenfk', true)).toBe('v1.1.19-beta.1');
  });

  it('gh CLI fallback (stable) excludes hub tags too', async () => {
    mockedAxios.get.mockRejectedValue(new Error('api down'));
    mockedExec
      .mockReturnValueOnce('hub-v1.1.19-beta.1' as any)   // `gh release view` → the hub tag
      .mockReturnValueOnce(JSON.stringify([               // → falls back to the list
        { tagName: 'hub-v1.1.19-beta.1', isPrerelease: false, createdAt: '2026-09-10T13:00:00Z' },
        { tagName: 'v1.1.18', isPrerelease: false, createdAt: '2026-09-08T00:00:00Z' },
      ]) as any);

    expect(await fetchLatestReleaseTag('cglab-public/agenfk', false)).toBe('v1.1.18');
  });

  it('a repo with no hub tags is unaffected', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        { tag_name: 'v2.1.0', published_at: '2026-09-09T00:00:00Z', prerelease: false },
        { tag_name: 'v2.0.0', published_at: '2026-09-01T00:00:00Z', prerelease: false },
      ],
    });
    // If the resolver reaches for the gh fallback here, that is a bug — fail
    // loudly instead of picking up whatever a previous test left in the mock.
    mockedExec.mockImplementation(() => { throw new Error('gh CLI must not be needed'); });

    expect(await fetchLatestReleaseTag('some/other', false)).toBe('v2.1.0');
  });
});
