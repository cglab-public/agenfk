/**
 * CGLAB-388 (S10 review) — commitStagedForCard reports the sha of the commit
 * IT made, read from git's report of that commit, not HEAD afterwards: in a
 * shared worktree another agent can commit in between.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { commitStagedForCard } from '../closeCommit';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim();
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-commit-sha-'));
  dirs.push(dir);
  sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', dir);
  return dir;
}
const card = { id: 'c1', type: 'TASK', title: 'Mine' } as any;

describe('commitStagedForCard sha', () => {
  it('is the commit it made, even when another agent commits right after', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); sh('git add mine.txt', dir);
    const run = (args: string[]) => {
      const out = git(args);
      if (args.includes('commit')) {
        // Another agent in the same worktree lands a commit straight after ours.
        fs.writeFileSync(path.join(dir, 'theirs.txt'), 't');
        sh('git add theirs.txt && git commit -qm theirs', dir);
      }
      return out;
    };
    const r = commitStagedForCard(card, dir, { run }, undefined, { message: 'step(PLAN): Mine [c1]' });
    expect(r.committed).toBe(true);
    expect(r.sha).toBe(sh('git log -1 --format=%H --grep=^step', dir));
    expect(r.sha).not.toBe(sh('git rev-parse HEAD', dir));
  });

  it('works on the first commit of a repository (git prints root-commit)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-commit-sha-root-'));
    dirs.push(dir);
    sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a', dir);
    const r = commitStagedForCard(card, dir, { run: git });
    expect(r.sha).toBe(sh('git rev-parse HEAD', dir));
  });
});
