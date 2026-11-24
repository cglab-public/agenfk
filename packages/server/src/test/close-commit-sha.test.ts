/**
 * CGLAB-388 (S10 review) — commitStagedForCard reports the sha of the commit
 * IT made, read from git's report of that commit, not HEAD afterwards: in a
 * shared worktree another agent can commit in between.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { commitStagedForCard } from '../closeCommit';
import { echoRepo, A } from './helpers/echoRepo';
import { gitSync, writeFiles, cloneGitTemplate, type GitTemplateBuild } from './helpers/gitFixture';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo() {
  const dir = echoRepo(A, 'agenfk-commit-sha-');
  dirs.push(dir);
  return dir;
}
/** A repository with `a` staged and no commit yet. */
const buildStagedNoCommit: GitTemplateBuild = (d) => {
  gitSync(d, 'init', '-q', '-b', 'main');
  gitSync(d, 'config', 'user.email', 't@t');
  gitSync(d, 'config', 'user.name', 't');
  writeFiles(d, { a: 'a\n' });
  gitSync(d, 'add', 'a');
};
const card = { id: 'c1', type: 'TASK', title: 'Mine' } as any;

describe('commitStagedForCard sha', () => {
  it('is the commit it made, even when another agent commits right after', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); gitSync(dir, 'add', 'mine.txt');
    const run = (args: string[]) => {
      const out = git(args);
      if (args.includes('commit')) {
        // Another agent in the same worktree lands a commit straight after ours.
        fs.writeFileSync(path.join(dir, 'theirs.txt'), 't');
        gitSync(dir, 'add', 'theirs.txt');
        gitSync(dir, 'commit', '-qm', 'theirs');
      }
      return out;
    };
    const r = commitStagedForCard(card, dir, { run }, { message: 'step(PLAN): Mine [c1]' });
    expect(r.committed).toBe(true);
    expect(r.sha).toBe(gitSync(dir, 'log', '-1', '--format=%H', '--grep=^step'));
    expect(r.sha).not.toBe(gitSync(dir, 'rev-parse', 'HEAD'));
  });

  it('works on the first commit of a repository (git prints root-commit)', async () => {
    const dir = cloneGitTemplate('close-commit-sha:staged-a-no-commit', buildStagedNoCommit, 'agenfk-commit-sha-root-');
    dirs.push(dir);
    const r = commitStagedForCard(card, dir, { run: git });
    expect(r.sha).toBe(gitSync(dir, 'rev-parse', 'HEAD'));
  });
});
