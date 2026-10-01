/**
 * 658ef023: the fleet reconciler's forced recovery (defaultSelfExtract)
 * untars the published build into the install root and runs
 * `npm ci --omit=dev` there. On a development checkout that overwrites tracked
 * files and dist with another version, and `npm ci --omit=dev` removes the
 * checkout's devDependencies. It only skipped its prune there; it must refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execSync = vi.fn(() => '');
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execSync: (...a: unknown[]) => execSync(...(a as [])),
}));

import { defaultSelfExtract } from '../hub/upgradeSync';

beforeEach(() => { execSync.mockClear(); });

describe('defaultSelfExtract on a development checkout', () => {
  it('refuses, and runs nothing - no download, no extract, no npm ci', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-devtree-'));
    fs.mkdirSync(path.join(root, '.git'));
    const result = await defaultSelfExtract({ installRoot: root, targetVersion: '9.9.9' });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/development checkout/i);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('still recovers an ordinary install root, which has no .git', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-install-'));
    await defaultSelfExtract({ installRoot: root, targetVersion: '9.9.9' });
    // It goes ahead: the download is the first thing it runs.
    expect(String((execSync.mock.calls[0] as unknown[] | undefined)?.[0] ?? '')).toMatch(/curl/);
  });

  it('still recovers ~/.agenfk-system, which is a clone in real installs', async () => {
    // Guard: only ever under the test run's sandbox HOME, never the machine's own install.
    expect(os.homedir()).not.toBe(os.userInfo().homedir);
    const root = path.join(os.homedir(), '.agenfk-system');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    try {
      await defaultSelfExtract({ installRoot: root, targetVersion: '9.9.9' });
      expect(String((execSync.mock.calls[0] as unknown[] | undefined)?.[0] ?? '')).toMatch(/curl/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
