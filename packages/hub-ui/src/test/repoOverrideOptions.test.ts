import { describe, it, expect } from 'vitest';
import { repoOverrideOptions } from '../pages/repoOverrideOptions';

describe('repoOverrideOptions', () => {
  it('maps discovery rows to repo-keyed options', () => {
    const opts = repoOverrideOptions([
      { remoteUrl: 'git@github.com:acme/web.git', lastSeen: '2026-05-05T10:00:00Z' },
    ]);
    expect(opts).toEqual([
      { id: 'git@github.com:acme/web.git', label: 'git@github.com:acme/web.git', sub: 'last seen 2026-05-05T10:00:00Z' },
    ]);
  });

  it('dedups by repo (same repo from multiple projects collapses to one)', () => {
    const opts = repoOverrideOptions([
      { remoteUrl: 'git@github.com:acme/web.git', lastSeen: '2026-05-05T10:00:00Z' },
      { remoteUrl: 'git@github.com:acme/web.git', lastSeen: '2026-05-04T10:00:00Z' },
      { remoteUrl: 'git@github.com:acme/api.git', lastSeen: '2026-05-03T10:00:00Z' },
    ]);
    expect(opts.map(o => o.id)).toEqual(['git@github.com:acme/web.git', 'git@github.com:acme/api.git']);
  });

  it('skips rows with no remote URL (not repo-identifiable)', () => {
    const opts = repoOverrideOptions([
      { remoteUrl: null, lastSeen: '2026-05-05T10:00:00Z' },
      { remoteUrl: 'git@github.com:acme/web.git', lastSeen: '2026-05-04T10:00:00Z' },
    ]);
    expect(opts.map(o => o.id)).toEqual(['git@github.com:acme/web.git']);
  });

  it('returns empty for empty input', () => {
    expect(repoOverrideOptions([])).toEqual([]);
  });
});
