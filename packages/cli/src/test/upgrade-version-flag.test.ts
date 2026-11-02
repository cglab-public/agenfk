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
 * Behaviour-based: introspect the real constructed commander `program` object.
 * That `upgrade --version <ver>` reaches the upgrade action is pinned offline by
 * upgrade-no-silent-downgrade.test.ts ("a pinned release that does not exist…").
 */
import { describe, it, expect } from 'vitest';
import { program } from '../index';

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
});
