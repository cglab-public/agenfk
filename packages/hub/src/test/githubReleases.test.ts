/**
 * Tests for the GitHub release-list fetcher + in-memory TTL cache used by
 * the admin upgrade UI to populate its target-version dropdown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getAgenfkReleases,
  __resetAgenfkReleaseCache,
  __setReleaseFetcher,
  type ReleaseFetcher,
} from '../services/githubReleases';

const sampleReleases = [
  { tag_name: 'v0.3.0-beta.23' },
  { tag_name: '0.3.0-beta.22' },
  { tag_name: 'v0.2.28' },
];

function makeFetcher(payload: any, ok = true, throwError?: Error): ReleaseFetcher & { calls: number } {
  let calls = 0;
  const fn: any = async () => {
    calls++;
    if (throwError) throw throwError;
    return { ok, status: ok ? 200 : 500, json: async () => payload };
  };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  return fn;
}

describe('githubReleases service', () => {
  beforeEach(() => {
    __resetAgenfkReleaseCache();
  });
  afterEach(() => {
    __resetAgenfkReleaseCache();
    __setReleaseFetcher(null);
  });

  it('fetches releases and returns version strings without leading v', async () => {
    const fetcher = makeFetcher(sampleReleases);
    __setReleaseFetcher(fetcher);

    const versions = await getAgenfkReleases();

    expect(versions).toEqual(['0.3.0-beta.23', '0.3.0-beta.22', '0.2.28']);
    expect(fetcher.calls).toBe(1);
  });

  it('serves the cached value within the TTL window', async () => {
    const fetcher = makeFetcher(sampleReleases);
    __setReleaseFetcher(fetcher);

    await getAgenfkReleases();
    await getAgenfkReleases();
    await getAgenfkReleases();

    expect(fetcher.calls).toBe(1);
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = makeFetcher(sampleReleases);
      __setReleaseFetcher(fetcher);

      await getAgenfkReleases();
      // Advance well past the 10-minute TTL.
      vi.advanceTimersByTime(11 * 60 * 1000);
      await getAgenfkReleases();

      expect(fetcher.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the last-good cache when GitHub is unreachable', async () => {
    vi.useFakeTimers();
    try {
      const goodFetcher = makeFetcher(sampleReleases);
      __setReleaseFetcher(goodFetcher);
      const first = await getAgenfkReleases();

      // After TTL expiry the next call fails — service should serve stale cache.
      vi.advanceTimersByTime(11 * 60 * 1000);
      const failingFetcher = makeFetcher(null, false, new Error('boom'));
      __setReleaseFetcher(failingFetcher);
      const second = await getAgenfkReleases();

      expect(second).toEqual(first);
      expect(failingFetcher.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when there is no cache and the first fetch fails', async () => {
    const failingFetcher = makeFetcher(null, false, new Error('boom'));
    __setReleaseFetcher(failingFetcher);

    await expect(getAgenfkReleases()).rejects.toThrow();
  });

  it('skips draft releases and entries without a tag_name', async () => {
    const fetcher = makeFetcher([
      { tag_name: 'v0.4.0' },
      { tag_name: '0.3.9', draft: true },
      { tag_name: null },
      {},
      { tag_name: 'v0.3.8' },
    ]);
    __setReleaseFetcher(fetcher);

    const versions = await getAgenfkReleases();
    expect(versions).toEqual(['0.4.0', '0.3.8']);
  });
});
