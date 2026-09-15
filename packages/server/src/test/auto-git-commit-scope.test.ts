import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { autoGitCommit } from '../server.js';

describe('autoGitCommit staging scope (CGLAB-22)', () => {
  it('commits tracked modifications but never stages unrelated untracked files', async () => {
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-autocommit-'));
    const git = (cmd: string) => execSync('git ' + cmd, { cwd: tmp, stdio: 'pipe' }).toString();
    try {
      git('init -q');
      git('config user.email test@example.com');
      git('config user.name Tester');
      git('checkout -q -b main');
      fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'v1\n');
      git('add tracked.txt');
      git('commit -q -m initial');

      // A tracked modification that SHOULD be committed by the DONE auto-commit
      fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'v2\n');
      // An unrelated untracked WIP file that must NOT be swept in
      fs.writeFileSync(path.join(tmp, 'unrelated-wip.txt'), 'wip\n');

      const item = { id: 'abc123', type: 'BUG', title: 'demo bug' } as any;
      const result = await autoGitCommit(item, tmp);

      expect(result.success).toBe(true);

      const head = git('log -1 --pretty=%s').trim();
      expect(head).toBe('close(bug): demo bug [abc123]');

      const treeFiles = git('ls-tree -r --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
      // tracked modification is in the commit
      expect(treeFiles).toContain('tracked.txt');
      // unrelated untracked file must NOT be in the commit
      expect(treeFiles).not.toContain('unrelated-wip.txt');

      // and it is still present as untracked in the working tree
      const status = git('status --porcelain');
      expect(status).toContain('?? unrelated-wip.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves a NEW file for the author rather than guessing whose it is", async () => {
    // The flip side of the fix, stated so it is a decision and not a surprise:
    // a file git has never seen is not committed by the close. The server
    // cannot tell whose it is, and guessing wrong attributes someone else's
    // work to this item — which is the harm this bug caused in the first place.
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-autocommit-new-'));
    const git = (cmd: string) => execSync('git ' + cmd, { cwd: tmp, stdio: 'pipe' }).toString();
    try {
      git('init -q');
      git('config user.email test@example.com');
      git('config user.name Tester');
      git('checkout -q -b main');
      fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'v1\n');
      git('add tracked.txt');
      git('commit -q -m initial');

      // Staged by the author — git knows about it, so the close carries it.
      fs.writeFileSync(path.join(tmp, 'mine.txt'), 'deliberate\n');
      git('add mine.txt');
      // Never staged — the close must leave it alone.
      fs.writeFileSync(path.join(tmp, 'somebody-elses.txt'), 'wip\n');

      const item = { id: 'abc124', type: 'TASK', title: 'adds a file' } as any;
      expect((await autoGitCommit(item, tmp)).success).toBe(true);

      const tree = git('ls-tree -r --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
      expect(tree).toContain('mine.txt');
      expect(tree).not.toContain('somebody-elses.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('deletes a tracked file the item removed', async () => {
    // `-u` covers deletions as well as modifications; without that a close
    // would commit half the change and leave the repo inconsistent.
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agenfk-autocommit-del-'));
    const git = (cmd: string) => execSync('git ' + cmd, { cwd: tmp, stdio: 'pipe' }).toString();
    try {
      git('init -q');
      git('config user.email test@example.com');
      git('config user.name Tester');
      git('checkout -q -b main');
      fs.writeFileSync(path.join(tmp, 'gone.txt'), 'bye\n');
      git('add gone.txt');
      git('commit -q -m initial');
      fs.unlinkSync(path.join(tmp, 'gone.txt'));

      const item = { id: 'abc125', type: 'TASK', title: 'removes a file' } as any;
      expect((await autoGitCommit(item, tmp)).success).toBe(true);
      const tree = git('ls-tree -r --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
      expect(tree).not.toContain('gone.txt');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
