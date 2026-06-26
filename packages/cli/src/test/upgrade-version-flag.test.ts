/**
 * BUG 7f85715b — `agenfk upgrade --version <ver>` collided with commander's
 * GLOBAL `--version` flag (`program.version(CURRENT_VERSION, '-V, --version')`).
 * commander's global option won, so the CLI printed its own version and exited
 * 0 without installing anything. The hub reconciler always upgrades via this
 * exact form (`upgradeSync.ts` DEFAULT_CLI_ARGS: `['upgrade','--version',<v>]`),
 * so every hub-driven pinned upgrade silently no-op'd and the reconciler
 * reported "exited 0 but on-disk version is X, expected Y".
 *
 * Fix: the global version flag must NOT claim `--version` (so the `upgrade`
 * subcommand's `--version <ver>` option is the one that binds). Bare
 * `agenfk --version` / `agenfk -V` is handled manually at the top level.
 *
 * Mix of source-introspection (cheap, runs in root suite) and a behavioral
 * spawn against the built CLI when the dist is present.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/index.ts'), 'utf8');

describe('BUG 7f85715b: --version flag no longer collides with the upgrade pin option', () => {
  it('the upgrade command still declares its --version <ver> pin option', () => {
    const upIdx = CLI_SRC.search(/\.command\(['"]upgrade['"]\)/);
    const next = CLI_SRC.indexOf('.command(', upIdx + 10);
    const section = CLI_SRC.slice(upIdx, next === -1 ? undefined : next);
    expect(section).toMatch(/\.option\(\s*['"]--version <ver>['"]/);
  });

  it('commander\'s global version flag does NOT claim the long --version (only -V), so it cannot intercept the subcommand', () => {
    // The old, broken form bound BOTH: `.version(CURRENT_VERSION, '-V, --version', …)`.
    // After the fix there must be no global registration of the long `--version`
    // flag — either no `.version(` call, or one scoped to `-V` only.
    const versionCalls = [...CLI_SRC.matchAll(/\.version\(\s*CURRENT_VERSION[^)]*\)/g)].map(m => m[0]);
    for (const call of versionCalls) {
      expect(call).not.toMatch(/--version/);
    }
  });

  it('handles bare -V / --version manually at the top level (so `agenfk --version` still works)', () => {
    // A manual guard must print CURRENT_VERSION and exit for a bare version
    // invocation, since we removed commander's auto global flag.
    expect(CLI_SRC).toMatch(/--version|'-V'/);
    expect(CLI_SRC).toMatch(/console\.log\(CURRENT_VERSION\)|process\.stdout\.write\(CURRENT_VERSION/);
  });

  it('built CLI: `upgrade --version <bogus> --json` attempts an upgrade (does NOT just print the version)', () => {
    const bin = path.join(REPO_ROOT, 'packages/cli/dist/index.js');
    if (!fs.existsSync(bin)) return; // dist not built in this environment; skip behavioral check
    const res = spawnSync('node', [bin, 'upgrade', '--version', '0.0.0-no-such-release', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
      // The CLI's main block is guarded by `NODE_ENV !== 'test'`; vitest sets
      // NODE_ENV=test and spawnSync would inherit it, short-circuiting the CLI.
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const out = (res.stdout || '').trim();
    // The broken behavior printed a bare semver (the CLI's own version) and exited.
    // The fixed behavior tries to resolve the bogus release and emits a JSON
    // failure object. Either way, the output must NOT be just a bare version.
    const lastLine = out.split('\n').filter(Boolean).pop() || '';
    expect(lastLine).not.toMatch(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(out).toMatch(/"status"\s*:\s*"failed"|not found|Failed to resolve/i);
  });
});
