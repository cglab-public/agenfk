/**
 * core releaseChannel (BUG 022b229a): the one rule the server's /releases/latest
 * and the CLI's fallback share for "the latest stable" and its upgrade tier.
 */
import { describe, it, expect } from 'vitest';
import { isFrameworkStable, newestFrameworkStable, newerFrameworkStables, strongestTier } from '../releaseChannel';

const r = (tag_name: string, extra: Record<string, unknown> = {}) => ({ tag_name, ...extra });

describe('releaseChannel', () => {
  it('a framework stable is a parseable, non-hub, non-draft tag with no prerelease flag or part', () => {
    expect(isFrameworkStable(r('v2.0.0'))).toBe(true);
    for (const bad of [r('hub-v2.0.0'), r('v2.0.0', { draft: true }), r('v2.0.0', { prerelease: true }), r('v2.1.0-beta.1'), r('desktop-1'), r(''), null]) {
      expect(isFrameworkStable(bad as any)).toBe(false);
    }
  });

  it('newest by version, whatever order the sources gave', () => {
    expect(newestFrameworkStable([r('v1.1.21'), r('v2.0.0'), r('v2.1.0-beta.1'), r('hub-v3.0.0')])?.tag_name).toBe('v2.0.0');
    expect(newestFrameworkStable([r('hub-v1.0.0')])).toBeNull();
  });

  it('newer stables than the install, nearest first, deduplicated and capped from the far end', () => {
    const rels = [r('v2.0.0'), r('v1.1.21'), r('v2.0.0'), r('v3.0.0'), r('v1.0.0')];
    expect(newerFrameworkStables(rels, '1.1.20').map(x => x.tag_name)).toEqual(['v1.1.21', 'v2.0.0', 'v3.0.0']);
    expect(newerFrameworkStables(rels, '2.0.0-beta.24').map(x => x.tag_name)).toEqual(['v2.0.0', 'v3.0.0']);
    // The cap keeps the hotfix for the installed line, not the newest majors.
    expect(newerFrameworkStables(rels, '1.1.20', 1).map(x => x.tag_name)).toEqual(['v1.1.21']);
  });

  it('the strongest tier wins; anything unknown counts optional', () => {
    expect(strongestTier(['optional', 'mandatory', 'recommended'])).toBe('mandatory');
    expect(strongestTier(['recommended', undefined, 'bogus'])).toBe('recommended');
    expect(strongestTier([])).toBe('optional');
  });
});
