/**
 * The integration list has to match what the repo actually ships (eb5770a2).
 *
 * `agenfk integration list` is consulted as the source of truth for "which
 * clients does AgEnFK support", which is exactly what it exists to answer. It
 * was wrong: it named claude, opencode, cursor, codex and gemini, and left out
 * pi - the client with the DEEPEST integration in the repo, a native extension
 * with a pre-edit gatekeeper, the mcp-enforcer and PR-sizing built in. Cursor,
 * meanwhile, was listed while having no hook system at all, so its enforcement
 * is instructional only.
 *
 * THE COST WAS NOT HYPOTHETICAL. During CGLAB-169 this list was taken as the
 * source of truth for the terminal's agent picker. pi was left out and opencode
 * put in, and the user had to correct both. A list that is merely incomplete is
 * one thing; a list that is confidently wrong about its own subject is what
 * this test exists to prevent.
 *
 * SO IT IS DERIVED, NOT RESTATED. Asserting a hand-written array against
 * another hand-written map would pass the day somebody adds a client and
 * forgets the list - which is the whole defect. The expected set comes from
 * the installer, so the next platform added there and not here fails this test
 * instead of misleading a reader.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every platform the INSTALLER knows how to install.
 *
 * Derived from `scripts/install.mjs`, which is the actual authority: whatever
 * `shouldRun` gates is what `--only <platform>` accepts and what a full
 * install copies. The CLI's list is a claim ABOUT that, and this test is the
 * only thing tying the two together.
 *
 * The first attempt at this derived the set from the files in bin/ instead,
 * and it was wrong in a way worth recording: `agenfk-mcp-enforcer.mjs` is one
 * of Claude Code's own hooks, but a pattern reading the last segment as a
 * client name turned it into a client called "enforcer". The artefacts do not
 * carry the platform reliably - three different shapes, some suffixed, some
 * not - and the installer does.
 */
function platformsTheInstallerKnows(): Set<string> {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/install.mjs'), 'utf8');
  const found = [...src.matchAll(/shouldRun\('([a-z-]+)'\)/g)].map(m => m[1]);
  if (found.length === 0) throw new Error('no shouldRun() calls found - has install.mjs been restructured?');
  return new Set(found);
}

/** The CLI's own map, read from source so the test needs no build step. */
function declaredPlatforms(): { aliases: string[]; labels: string[] } {
  const src = fs.readFileSync(path.join(repoRoot, 'packages/cli/src/index.ts'), 'utf8');
  const grab = (name: string): string[] => {
    const block = new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(src);
    if (!block) throw new Error(`${name} not found in packages/cli/src/index.ts`);
    return [...block[1].matchAll(/^\s*'?([\w-]+)'?:/gm)].map(m => m[1]);
  };
  return { aliases: grab('INTEGRATION_ALIASES'), labels: grab('INTEGRATION_LABELS') };
}

describe('every client the repo ships for is one the CLI admits to', () => {
  it('names pi, which has the deepest integration of all of them', () => {
    /*
     * Called out by name rather than left to the derived check alone. pi is the
     * case that actually went wrong, and a named test says so to whoever reads
     * the failure - a set difference does not explain itself.
     */
    expect(platformsTheInstallerKnows()).toContain('pi');
    expect(declaredPlatforms().labels).toContain('pi');
  });

  it('leaves none of them out', () => {
    const shipped = platformsTheInstallerKnows();
    const labels = new Set(declaredPlatforms().labels);
    const missing = [...shipped].filter(c => !labels.has(c));
    expect(missing, `the installer handles these and the CLI does not list them: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('claims none the repo does not ship', () => {
    // The other direction, and the one that strands a user: `integration
    // install <x>` for a platform with nothing to copy.
    const shipped = platformsTheInstallerKnows();
    const extra = declaredPlatforms().labels.filter(p => !shipped.has(p));
    expect(extra, `the CLI lists these and the installer cannot install them: ${extra.join(', ')}`)
      .toEqual([]);
  });

  it('can be installed by name, not only by "all"', () => {
    /*
     * `integration install pi` resolved through INTEGRATION_ALIASES and there
     * was no entry, so the only route that reached pi was `all` - and a user
     * asking for one client by name got told it was unsupported.
     */
    const { aliases, labels } = declaredPlatforms();
    for (const platform of labels) {
      expect(aliases, `${platform} is listed but cannot be named on the command line`)
        .toContain(platform);
    }
  });
});
