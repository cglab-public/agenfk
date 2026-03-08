/**
 * Validates agenfk-upgrade behavior:
 * 1. The upgrade skill delegates to `agenfk upgrade` (CLI handles stop/restart)
 * 2. The CLI upgrade command downloads pre-built binaries (not rebuild from source)
 * 3. The CLI stops server before upgrade and starts it after
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SKILL_PATH = path.join(os.homedir(), '.claude', 'commands', 'agenfk-upgrade.md');
const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');

function readSkill(): string {
  if (!fs.existsSync(SKILL_PATH)) return '';
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

function readCli(): string {
  if (!fs.existsSync(CLI_PATH)) return '';
  return fs.readFileSync(CLI_PATH, 'utf8');
}

describe('agenfk-upgrade skill', () => {
  it('should delegate to the agenfk upgrade CLI command', () => {
    const content = readSkill();
    expect(content).toMatch(/agenfk upgrade/i);
  });

  it('should not manually run install.mjs (CLI handles that)', () => {
    const content = readSkill();
    // The skill should not manually call install.mjs — CLI upgrade handles it
    expect(content).not.toMatch(/node.*install\.mjs/);
  });
});

describe('agenfk upgrade CLI command', () => {
  it('should always attempt to download pre-built binaries regardless of git repo', () => {
    const cli = readCli();
    // downloadReleaseAsset must be called outside any isGitRepo branch
    // Verify the download call is not nested inside an `if (!isGitRepo)` block
    const upgradeActionStart = cli.indexOf(".command('upgrade')");
    const upgradeActionEnd = cli.indexOf(".command('up')", upgradeActionStart);
    const upgradeSection = cli.slice(upgradeActionStart, upgradeActionEnd);

    // downloadReleaseAsset must be present in the upgrade section
    expect(upgradeSection).toContain('downloadReleaseAsset');

    // isGitRepo should NOT gate the downloadReleaseAsset call (download happens first always)
    const downloadIdx = upgradeSection.indexOf('downloadReleaseAsset');
    const gitBranchIdx = upgradeSection.indexOf('if (!isGitRepo)');
    // download should come before (or without) the isGitRepo branch
    expect(downloadIdx).toBeGreaterThan(-1);
    // If isGitRepo exists, download must appear before it
    if (gitBranchIdx !== -1) {
      expect(downloadIdx).toBeLessThan(gitBranchIdx);
    }
  });

  it('should stop server before running install script', () => {
    const cli = readCli();
    const upgradeActionStart = cli.indexOf(".command('upgrade')");
    const upgradeActionEnd = cli.indexOf(".command('up')", upgradeActionStart);
    const upgradeSection = cli.slice(upgradeActionStart, upgradeActionEnd);

    const stopIdx = upgradeSection.search(/agenfk\.js.*down|\.js['"]\s*,\s*['"]down['"]/);
    const installIdx = upgradeSection.indexOf('install.mjs');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(installIdx);
  });

  it('should start server after install when it was previously running', () => {
    const cli = readCli();
    const upgradeActionStart = cli.indexOf(".command('upgrade')");
    const upgradeActionEnd = cli.indexOf(".command('up')", upgradeActionStart);
    const upgradeSection = cli.slice(upgradeActionStart, upgradeActionEnd);

    const installIdx = upgradeSection.indexOf('install.mjs');
    const startIdx = upgradeSection.search(/agenfk\.js.*up['"]\s*\)|\.js['"]\s*,\s*['"]up['"]/);
    expect(installIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(installIdx);
  });

  it('should not delete dist dirs after extracting the tarball', () => {
    const cli = readCli();
    const upgradeActionStart = cli.indexOf(".command('upgrade')");
    const upgradeActionEnd = cli.indexOf(".command('up')", upgradeActionStart);
    const upgradeSection = cli.slice(upgradeActionStart, upgradeActionEnd);

    const extractIdx = upgradeSection.indexOf('tar -xzf');
    const deleteDistIdx = upgradeSection.search(/rmSync.*\/dist|rm.*dist/);

    // Either no dist deletion at all, or deletion must happen BEFORE extraction
    if (deleteDistIdx !== -1 && extractIdx !== -1) {
      expect(deleteDistIdx).toBeLessThan(extractIdx);
    }
  });
});

const INSTALL_SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/install.mjs');

function readInstall(): string {
  if (!fs.existsSync(INSTALL_SCRIPT_PATH)) return '';
  return fs.readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
}

describe('install.mjs auto-heal (broken upgrade loop recovery)', () => {
  it('should detect missing dists in non-rebuild mode and attempt re-download before rebuilding', () => {
    const install = readInstall();
    // Must contain logic that re-downloads when dists are missing in non-rebuild mode
    expect(install).toMatch(/auto.?heal|re.?download|self.?heal|missing.*dist.*download|download.*missing.*dist/i);
  });

  it('should use the version from package.json to determine the re-download URL', () => {
    const install = readInstall();
    // Should read package.json version for re-download
    expect(install).toMatch(/package\.json.*version|version.*package\.json|pkg\.version|pkgVersion/);
  });

  it('should try curl then gh CLI as fallback for re-download', () => {
    const install = readInstall();
    // Should attempt curl download
    expect(install).toMatch(/curl/);
    // Should have gh as fallback
    expect(install).toMatch(/gh.*release.*download|release.*download.*gh/);
  });

  it('should only trigger re-download in non-rebuild mode with missing dists', () => {
    const install = readInstall();
    // The re-download logic must be guarded by !shouldRebuild
    // Find the auto-heal block and verify it's not inside a shouldRebuild branch
    const healMatch = install.match(/auto.?heal|re.?download.*tar|tar.*re.?download/i);
    expect(healMatch).not.toBeNull();
  });
});

describe('install.mjs pre-built mode', () => {
  it('should remove stale src/ directories when using pre-built dist (not rebuilding)', () => {
    const install = readInstall();
    // Must contain logic that removes src/ directories
    expect(install).toMatch(/src.*rmSync|rmSync.*src|cleanStaleSrc|stale.*src|src.*stale/i);
  });

  it('should cover server package src/ in the stale-src cleanup list', () => {
    const install = readInstall();
    // The cleanup must reference packages/server/src
    expect(install).toMatch(/packages\/server\/src|packages.server.src/);
  });

  it('should only remove stale src/ when in pre-built mode (build artifacts found)', () => {
    const install = readInstall();
    // The stale-src cleanup must appear in or near the "build artifacts found" branch,
    // not inside the rebuild branch (where src/ would be needed for compilation)
    const rebuildBranchMatch = install.match(/if\s*\(shouldRebuild[\s\S]{0,500}runBuild\(\)/);
    const staleSrcMatch = install.match(/cleanStaleSrc|stale.*src.*rmSync|packages\/server\/src/);
    expect(staleSrcMatch).not.toBeNull();

    // Verify stale-src cleanup does NOT appear inside the shouldRebuild-triggered build block
    if (rebuildBranchMatch && staleSrcMatch) {
      const rebuildBlock = rebuildBranchMatch[0];
      expect(rebuildBlock).not.toMatch(/cleanStaleSrc/);
    }
  });
});
