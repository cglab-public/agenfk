/**
 * Tests for CLI startup tier enforcement (Story 2).
 *
 * The CLI should check the upgrade tier at startup (with a local cache, ~1h TTL).
 * - mandatory tier: print error and exit(1), blocking all commands
 * - recommended tier: print banner, continue normally
 * - optional/absent: silent
 *
 * All tests are intentionally failing until the feature is implemented.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');
const readCli = () => (fs.existsSync(CLI_PATH) ? fs.readFileSync(CLI_PATH, 'utf8') : '');

// ── Startup tier check function ───────────────────────────────────────────────

describe('CLI startup — upgrade tier check function', () => {
  it('should define a startup upgrade tier check function', () => {
    const cli = readCli();
    expect(cli).toMatch(/checkUpgradeTier|checkTierOnStartup|startupTierCheck|tierCheck/i);
  });

  it('should call the tier check function before processing commands', () => {
    const cli = readCli();
    // The tier check must be invoked in the main execution path, before command dispatch
    const tierCheckIdx = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const parseIdx = cli.search(/program\.parseAsync|program\.parse\b/);
    expect(tierCheckIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    expect(tierCheckIdx).toBeLessThan(parseIdx);
  });
});

// ── Upgrade tier cache ────────────────────────────────────────────────────────

describe('CLI startup — upgrade tier cache', () => {
  it('should write the tier check result to a local cache file', () => {
    const cli = readCli();
    expect(cli).toMatch(/upgrade.*cache|tier.*cache|cache.*tier|upgradeCache|tierCache/i);
  });

  it('should use a cache TTL of approximately 1 hour', () => {
    const cli = readCli();
    // 1 hour in ms = 3600000 or expressed as 60 * 60 * 1000
    expect(cli).toMatch(/3600000|60\s*\*\s*60\s*\*\s*1000|1.*hour.*TTL|TTL.*hour/i);
  });

  it('should store the cache in the .agenfk directory or home directory', () => {
    const cli = readCli();
    expect(cli).toMatch(/\.agenfk|agenfk.*cache|homedir.*agenfk/i);
  });

  it('should skip the remote fetch and use cached data within the TTL window', () => {
    const cli = readCli();
    // Must have a condition that reads from cache if not expired
    expect(cli).toMatch(/fetchedAt|cachedAt|cacheTime|Date\.now.*TTL|TTL.*Date\.now/i);
  });
});

// ── Mandatory tier enforcement ────────────────────────────────────────────────

describe('CLI startup — mandatory tier blocks all commands', () => {
  it('should call process.exit(1) when the mandatory tier is detected', () => {
    const cli = readCli();
    const tierCheckStart = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const tierSection = cli.slice(tierCheckStart, tierCheckStart + 3000);
    expect(tierSection).toMatch(/mandatory/i);
    expect(tierSection).toMatch(/process\.exit\(1\)/);
  });

  it('should print a prominent error message for mandatory upgrades', () => {
    const cli = readCli();
    const tierCheckStart = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const tierSection = cli.slice(tierCheckStart, tierCheckStart + 3000);
    // Must output a visible error (chalk red, console.error, or similar)
    expect(tierSection).toMatch(/MANDATORY|mandatory.*upgrade|upgrade.*required|must upgrade/i);
  });

  it('should show the upgrade command to run in the mandatory error message', () => {
    const cli = readCli();
    const tierCheckStart = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const tierSection = cli.slice(tierCheckStart, tierCheckStart + 3000);
    expect(tierSection).toMatch(/agenfk upgrade/i);
  });
});

// ── Recommended tier banner ───────────────────────────────────────────────────

describe('CLI startup — recommended tier shows banner', () => {
  it('should print a banner (not exit) for recommended tier', () => {
    const cli = readCli();
    // Find the apply/action function that handles tier enforcement
    const actionStart = cli.search(/applyUpgradeTierAction|function applyTier/i);
    const funcSection = actionStart >= 0
      ? cli.slice(actionStart, actionStart + 1500)
      : cli.slice(cli.search(/checkUpgradeTier/i), cli.search(/checkUpgradeTier/i) + 4000);
    expect(funcSection).toMatch(/recommended/i);
    // process.exit(1) must appear at most once (only in the mandatory branch)
    // and must NOT appear in the recommended conditional block
    const exitCount = (funcSection.match(/process\.exit\(1\)/g) || []).length;
    expect(exitCount).toBeLessThanOrEqual(1);
    // The recommended block itself must not call exit
    const recBlockMatch = funcSection.match(/(?:else\s+if|===\s*['"]recommended['"])[\s\S]{0,400}/);
    if (recBlockMatch) {
      expect(recBlockMatch[0]).not.toMatch(/process\.exit\(1\)/);
    }
  });

  it('should print a banner message suggesting the upgrade for recommended tier', () => {
    const cli = readCli();
    const tierCheckStart = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const tierSection = cli.slice(tierCheckStart, tierCheckStart + 3000);
    expect(tierSection).toMatch(/recommended.*upgrade|upgrade.*recommended|new.*version.*available/i);
  });
});

// ── Recommended banner must not corrupt stdout ────────────────────────────────
// The recommended-upgrade banner runs in the pre-parse startup path, so it
// prepends to whatever a command would print. Emitting it on stdout corrupts
// machine-readable output (`agenfk list --json | jq` → JSONDecodeError).
// Diagnostics belong on stderr; only command *data* goes to stdout.

describe('CLI startup — recommended banner is written to stderr, not stdout', () => {
  function getApplyFuncSection(cli: string): string {
    const defIdx = cli.search(/function applyUpgradeTierAction/i);
    if (defIdx === -1) return '';
    return cli.slice(defIdx, defIdx + 1200);
  }

  function getRecommendedBlock(cli: string): string {
    const func = getApplyFuncSection(cli);
    // Grab from the recommended conditional up to the next `}` chain / end.
    const recIdx = func.search(/===\s*['"]recommended['"]/);
    return recIdx >= 0 ? func.slice(recIdx, recIdx + 500) : '';
  }

  it('recommended branch emits the banner via console.error', () => {
    const cli = readCli();
    const block = getRecommendedBlock(cli);
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/console\.error/);
  });

  it('recommended branch does NOT emit the banner via console.log (would corrupt --json stdout)', () => {
    const cli = readCli();
    const block = getRecommendedBlock(cli);
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/console\.log/);
  });
});

// ── Optional tier ─────────────────────────────────────────────────────────────

describe('CLI startup — optional tier is silent', () => {
  it('should not exit or print a banner for optional/absent tier', () => {
    const cli = readCli();
    const tierCheckStart = cli.search(/checkUpgradeTier|checkTierOnStartup|startupTierCheck/i);
    const tierSection = cli.slice(tierCheckStart, tierCheckStart + 3000);
    // The optional branch must exist (handles the default case)
    expect(tierSection).toMatch(/optional|else\s*\{|default:/i);
  });
});

// ── Version-match suppression ─────────────────────────────────────────────────
// When the local version already equals the remote version, no warning should
// be displayed — not even for recommended tier.  The root cause was that
// applyUpgradeTierAction showed the banner regardless of whether an upgrade
// was actually available.

describe('CLI startup — suppress tier warning when already on latest version', () => {
  // Helper: find the function *definition* (not call sites)
  function getApplyFuncSection(cli: string): string {
    // Match "function applyUpgradeTierAction(" to find the definition
    const defIdx = cli.search(/function applyUpgradeTierAction/i);
    if (defIdx === -1) return '';
    return cli.slice(defIdx, defIdx + 1200);
  }

  it('applyUpgradeTierAction checks latestVersion against CURRENT_VERSION before showing warning', () => {
    const cli = readCli();
    const funcSection = getApplyFuncSection(cli);
    expect(funcSection.length).toBeGreaterThan(0);
    // Must guard on version equality — look for CURRENT_VERSION or a semver compare
    expect(funcSection).toMatch(/CURRENT_VERSION|currentVersion/i);
  });

  it('applyUpgradeTierAction returns early when the advertised version is not strictly newer', () => {
    const cli = readCli();
    const funcSection = getApplyFuncSection(cli);
    expect(funcSection.length).toBeGreaterThan(0);
    // Must have an early-return guard gated on a proper semver comparison
    // (isUpgrade/compareSemver) so an equal OR older version never nags.
    expect(funcSection).toMatch(/(isUpgrade|compareSemver)\([^)]*CURRENT_VERSION/i);
  });

  it('recommended banner is NOT shown unless the advertised version is newer', () => {
    const cli = readCli();
    const funcSection = getApplyFuncSection(cli);
    expect(funcSection.length).toBeGreaterThan(0);
    // The version-newness guard must appear BEFORE the recommended block.
    const versionCheckIdx = funcSection.search(/(isUpgrade|compareSemver)\([^)]*CURRENT_VERSION/i);
    const recommendedIdx = funcSection.search(/recommended/i);
    expect(versionCheckIdx).toBeGreaterThan(-1);
    expect(recommendedIdx).toBeGreaterThan(-1);
    expect(versionCheckIdx).toBeLessThan(recommendedIdx);
  });
});
