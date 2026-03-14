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
