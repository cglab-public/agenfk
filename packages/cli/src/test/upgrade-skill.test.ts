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
