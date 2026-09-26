import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { releaseHint } from '../releaseHint';

/**
 * d26832d6 #23: `agenfk pr create` told a user project (marketing-lab) to run
 * /agenfk-release - a command that is repo-private to the framework and never
 * shipped. The hint belongs only where the command exists.
 */
describe('releaseHint', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-hint-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('says nothing in a repository that has no /agenfk-release command', () => {
    expect(releaseHint(root, 'merged')).toBeNull();
    expect(releaseHint(root, 'open')).toBeNull();
  });

  it('names /agenfk-release where the repository carries it', () => {
    fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'commands', 'agenfk-release.md'), '# release\n');
    expect(releaseHint(root, 'open')).toMatch(/\/agenfk-release/);
    expect(releaseHint(root, 'merged')).toMatch(/\/agenfk-release/);
  });

  it('says nothing when there is no repository root to look in', () => {
    expect(releaseHint(null, 'open')).toBeNull();
  });
});
