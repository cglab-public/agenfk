/**
 * BUG 8973cea3 — `agenfk upgrade --beta` must resolve the newest PRE-release, not
 * the most-recently-published release of any kind. The old resolver hit
 * /releases/latest (which excludes prereleases) or picked the newest release
 * regardless of `prerelease`, so a later stable — or an asset-less prerelease —
 * could be mis-resolved and 404 on download.
 *
 * Behaviour-based: mock the GitHub REST call and drive the real
 * `fetchLatestReleaseTag`, asserting it filters to prereleases and picks the
 * newest — replacing the old test that grepped index.ts for the filter source.
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
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import axios from 'axios';
import { fetchLatestReleaseTag } from '../index';

const mockedAxios = vi.mocked(axios, true);

describe('fetchLatestReleaseTag --beta resolves the newest prerelease (BUG 8973cea3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks the newest PRERELEASE, ignoring a newer stable release and older prereleases', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        { tag_name: 'v2.0.0', published_at: '2026-07-10T00:00:00Z', prerelease: false }, // newest overall, but STABLE
        { tag_name: 'v2.0.0-beta.3', published_at: '2026-07-08T00:00:00Z', prerelease: true }, // newest prerelease
        { tag_name: 'v2.0.0-beta.2', published_at: '2026-07-01T00:00:00Z', prerelease: true }, // older prerelease
        { tag_name: 'v1.9.0', published_at: '2026-06-01T00:00:00Z', prerelease: false },
      ],
    });

    const tag = await fetchLatestReleaseTag('org/repo', true);

    expect(tag).toBe('v2.0.0-beta.3'); // not the newer stable v2.0.0, not the older beta.2
    // It must query ALL releases, not /releases/latest (which omits prereleases).
    const url = mockedAxios.get.mock.calls[0][0] as string;
    expect(url).toContain('/releases?per_page=');
    expect(url).not.toContain('/releases/latest');
  });

  it('skips prerelease entries missing a tag_name or published_at', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        { tag_name: '', published_at: '2026-07-20T00:00:00Z', prerelease: true }, // no tag → ignored
        { tag_name: 'v2.0.0-beta.1', published_at: '2026-07-08T00:00:00Z', prerelease: true },
      ],
    });

    expect(await fetchLatestReleaseTag('org/repo', true)).toBe('v2.0.0-beta.1');
  });

  it('non-beta resolves /releases/latest (stable channel)', async () => {
    mockedAxios.get.mockResolvedValue({ data: { tag_name: 'v2.0.0' } });

    const tag = await fetchLatestReleaseTag('org/repo', false);

    expect(tag).toBe('v2.0.0');
    expect(mockedAxios.get.mock.calls[0][0]).toContain('/releases/latest');
  });
});
