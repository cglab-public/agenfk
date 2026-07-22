import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { autoGitCommit } from '../server.js';

describe('autoGitCommit staging scope (CGLAB-22)', () => {
  it('commits tracked modifications but never stages unrelated untracked files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.realpathSync(os.tmpdir()), 'agenfk-autocommit-'));
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
});