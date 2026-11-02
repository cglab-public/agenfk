/**
 * 4ac25844: the root `vitest run` is this project's verify command and its
 * test report, so it is every agenfk gate's view of the suite. It used to
 * exclude packages/ui/src/test/** (the board runs under its own config), so a
 * card could break the board's specs and pass every gate - f8d0a752 left
 * appSettingsDto.test.ts red and nothing held it.
 *
 * Asked of vitest itself, not of the config's text: which files would the root
 * run, and under which project's settings.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

// vitest names files with forward slashes on every OS (C:/Users/... on Windows),
// so the filters below accept either separator rather than path.sep.
function listed(args: string[] = []): Array<{ file: string; projectName: string }> {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe('the root vitest run', () => {
  it("runs the board's specs (packages/ui/src/test)", () => {
    const ui = listed().filter(f => /[\\/]packages[\\/]ui[\\/]src[\\/]test[\\/]/.test(f.file));
    expect(ui.length).toBeGreaterThan(0);
    expect(ui.map(f => f.file)).toEqual(expect.arrayContaining([expect.stringMatching(/appSettingsDto\.test\.ts$/)]));
  });

  it("runs them under the board's own settings (its project), not the node environment", () => {
    const ui = listed().filter(f => /[\\/]packages[\\/]ui[\\/]/.test(f.file));
    expect(new Set(ui.map(f => f.projectName))).toEqual(new Set(['ui']));
  });
});
