import { describe, it, expect } from 'vitest';
import { findDuplicateProjectRoots } from '../projectHygiene';

const p = (id: string, name: string, projectRoot?: string) => ({ id, name, projectRoot });

describe('findDuplicateProjectRoots', () => {
  it('groups projects that share the same projectRoot', () => {
    const dupes = findDuplicateProjectRoots([
      p('1', 'horizon-lab', '/Users/d/horizon/horizon-lab'),
      p('2', 'horizon-ds', '/Users/d/horizon/horizon-lab'),
      p('3', 'cglab-skills', '/Users/d/horizon/horizon-lab'),
      p('4', 'sast', '/Users/d/sast'),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].projectRoot).toBe('/Users/d/horizon/horizon-lab');
    expect(dupes[0].projects.map((x) => x.id).sort()).toEqual(['1', '2', '3']);
  });

  it('returns empty when every root is unique', () => {
    expect(
      findDuplicateProjectRoots([p('1', 'a', '/a'), p('2', 'b', '/b')]),
    ).toEqual([]);
  });

  it('ignores projects with no projectRoot (undefined/empty are not grouped)', () => {
    const dupes = findDuplicateProjectRoots([
      p('1', 'a'),
      p('2', 'b'),
      p('3', 'c', ''),
    ]);
    expect(dupes).toEqual([]);
  });

  it('normalizes trailing slashes so /x and /x/ count as the same root', () => {
    const dupes = findDuplicateProjectRoots([
      p('1', 'a', '/Users/d/repo'),
      p('2', 'b', '/Users/d/repo/'),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].projects.map((x) => x.id).sort()).toEqual(['1', '2']);
  });
});
