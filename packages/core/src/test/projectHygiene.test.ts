import { describe, it, expect } from 'vitest';
import { findDuplicateProjectRoots, isPersistableProjectRoot } from '../projectHygiene';

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

/**
 * Refusing to record a project root that cannot be one.
 *
 * Four projects on this machine ended up with `projectRoot` = `/Users/<user>`
 * — the home directory, not a repository — and the path that put them there is
 * ordinary: `findProjectRoot` walks up looking for a `.agenfk` directory, and
 * `~/.agenfk` exists. So `agenfk verify` run from anywhere under $HOME with no
 * closer `.agenfk` resolves to $HOME, and the result is persisted.
 *
 * What that costs is not untidiness. `projectRoot` is the directory a worktree
 * is cut from and the cwd `git add -A && git commit` runs in — so a project
 * rooted at $HOME points both at the user's private files.
 *
 * Detecting the duplicates after the fact (above) was only ever half the job.
 */
describe('a project root that must be refused', () => {
  const home = '/Users/someone';

  it('refuses the home directory itself', () => {
    expect(isPersistableProjectRoot('/Users/someone', home)).toBe(false);
  });

  it('refuses it however it is spelled', () => {
    // A trailing slash or a `.` segment is the same directory, and the check
    // is worth nothing if it can be walked around by accident.
    for (const spelling of ['/Users/someone/', '/Users/someone/.', '/Users/someone/./']) {
      expect(isPersistableProjectRoot(spelling, home), spelling).toBe(false);
    }
  });

  it('refuses the agenfk directory itself', () => {
    // ~/.agenfk is what the walk-up finds; recording it would point a worktree
    // at the framework's own state.
    expect(isPersistableProjectRoot('/Users/someone/.agenfk', home)).toBe(false);
  });

  it('accepts a real repository under home', () => {
    // The common case must keep working: most repos live under $HOME.
    expect(isPersistableProjectRoot('/Users/someone/code/agenfk', home)).toBe(true);
  });

  it('refuses nothing at all', () => {
    for (const empty of ['', '   ', undefined, null]) {
      expect(isPersistableProjectRoot(empty as never, home)).toBe(false);
    }
  });

  it('refuses the filesystem root', () => {
    // Same class of mistake with a worse blast radius.
    expect(isPersistableProjectRoot('/', home)).toBe(false);
  });
});
