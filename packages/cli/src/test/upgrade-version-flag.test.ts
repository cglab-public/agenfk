/**
 * BUG 7f85715b — `agenfk upgrade --version <ver>` collided with commander's
 * GLOBAL `--version` flag (`program.version(CURRENT_VERSION, '-V, --version')`).
 * commander's global option won, so the CLI printed its own version and exited
 * 0 without installing anything. The hub reconciler always upgrades via this
 * exact form (`upgradeSync.ts` DEFAULT_CLI_ARGS: `['upgrade','--version',<v>]`),
 * so every hub-driven pinned upgrade silently no-op'd.
 *
 * Fix: the global version flag must NOT claim `--version` (so the `upgrade`
 * subcommand's `--version <ver>` option is the one that binds). Bare
 * `agenfk -V` prints the version via commander; bare `agenfk --version` is
 * handled manually at the top level.
 *
 * Behaviour-based: introspect the real constructed commander `program` object,
 * plus an end-to-end spawn against the built CLI when the dist is present.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { program } from '../index';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function findCommand(name: string) {
  return program.commands.find((c) => c.name() === name);
}

describe('BUG 7f85715b: --version flag no longer collides with the upgrade pin option', () => {
  it('the upgrade command really exposes a --version <ver> pin option', () => {
    const upgrade = findCommand('upgrade');
    expect(upgrade).toBeDefined();
    const longs = (upgrade as any).options.map((o: any) => o.long);
    expect(longs).toContain('--version');
  });

  it('commander\'s global version flag binds only -V, never the long --version', () => {
    // .version(CURRENT_VERSION, '-V', …) registers a version option. It must
    // expose the short flag but NOT claim `--version`, or it would intercept the
    // upgrade subcommand's `--version <ver>`.
    const versionOption = (program as any)._versionOption ?? (program as any).options?.find(
      (o: any) => o.short === '-V' || /(^|,)\s*-V(\s|,|$)/.test(o.flags || ''),
    );
    expect(versionOption).toBeDefined();
    expect(versionOption.short).toBe('-V');
    expect(versionOption.long ?? null).not.toBe('--version');
    // And no other top-level option claims the long --version either.
    const topLongs = ((program as any).options || []).map((o: any) => o.long);
    expect(topLongs).not.toContain('--version');
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
