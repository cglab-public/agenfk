import * as fs from 'fs';
import * as path from 'path';

/**
 * What `agenfk pr create` / `pr check` say about releasing, or null.
 *
 * /agenfk-release is repo-private to the framework (.claude/commands/ in its
 * own repository, never shipped), so it is named only where the repository
 * carries it. A user project was told to run a command it does not have
 * (d26832d6 #23).
 */
export function releaseHint(root: string | null | undefined, state: 'open' | 'merged'): string | null {
  if (!root || !fs.existsSync(path.join(root, '.claude', 'commands', 'agenfk-release.md'))) return null;
  return state === 'merged'
    ? 'You can now run /agenfk-release to create a release.'
    : 'When your PR is approved and merged, run /agenfk-release to create a release.';
}
