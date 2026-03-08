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
const SKILL_REPO_PATH = path.resolve(__dirname, '../../../../commands/agenfk-upgrade.md');
const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');

function readSkill(): string {
  if (fs.existsSync(SKILL_PATH)) return fs.readFileSync(SKILL_PATH, 'utf8');
  if (fs.existsSync(SKILL_REPO_PATH)) return fs.readFileSync(SKILL_REPO_PATH, 'utf8');
  return '';
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

  it('should always attempt re-download when dists are missing (no fallback to source build)', () => {
    const install = readInstall();
    const healMatch = install.match(/auto.?heal|re.?download.*tar|tar.*re.?download/i);
    expect(healMatch).not.toBeNull();
  });
});

describe('install.mjs pre-built mode', () => {
  it('should remove stale src/ directories after dist-bundle extraction', () => {
    const install = readInstall();
    expect(install).toMatch(/src.*rmSync|rmSync.*src|cleanStaleSrc|stale.*src|src.*stale/i);
  });

  it('should cover server package src/ in the stale-src cleanup list', () => {
    const install = readInstall();
    expect(install).toMatch(/packages\/server\/src|packages.server.src/);
  });
});

describe('install.mjs dist-bundle-only (no source build)', () => {
  it('should NOT contain runBuild or npm run build', () => {
    const install = readInstall();
    expect(install).not.toMatch(/function runBuild|runBuild\(\)/);
    expect(install).not.toMatch(/npm.*run.*build|'run',\s*'build'/);
  });

  it('should NOT contain cleanDists function', () => {
    const install = readInstall();
    expect(install).not.toMatch(/function cleanDists|cleanDists\(\)/);
  });

  it('should NOT contain shouldRebuild flag', () => {
    const install = readInstall();
    expect(install).not.toMatch(/shouldRebuild/);
  });

  it('should NOT run npm install as part of a source build', () => {
    const install = readInstall();
    // npm install is only acceptable in a comment or string, not as a spawnSync call for building
    expect(install).not.toMatch(/spawnSync\s*\([^)]*'install'[^)]*\)/);
  });

  it('should exit with an error when dists are still missing after re-download', () => {
    const install = readInstall();
    // Must call process.exit(1) in the failure path (after re-download fails)
    expect(install).toMatch(/process\.exit\(1\)/);
    // The exit must follow a re-download failure check
    const redownloadIdx = install.search(/autoHeal|re.?download/i);
    const exitIdx = install.indexOf('process.exit(1)');
    expect(redownloadIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(redownloadIdx);
  });

  it('should NOT accept --rebuild flag', () => {
    const install = readInstall();
    expect(install).not.toMatch(/--rebuild/);
  });
});

describe('install.mjs --debuglog flag', () => {
  it('should parse --debuglog from process.argv', () => {
    const install = readInstall();
    expect(install).toMatch(/process\.argv.*debuglog|debuglog.*process\.argv|includes\(['"]--debuglog['"]\)/);
  });

  it('should define a debug logging helper that is gated on the debuglog flag', () => {
    const install = readInstall();
    // A debugLog / debug function that only emits when the flag is active
    expect(install).toMatch(/debugLog|debuglog|function debug/i);
    // The function must reference the debuglog flag
    expect(install).toMatch(/debugLog\s*=.*debuglog|debuglog.*&&.*console|if.*debuglog.*console/i);
  });

  it('should log environment variables relevant to db resolution under --debuglog', () => {
    const install = readInstall();
    // Must log AGENFK_DB_PATH env var
    expect(install).toMatch(/debugLog.*AGENFK_DB_PATH|AGENFK_DB_PATH.*debugLog/);
  });

  it('should log the resolved config.json path and its contents under --debuglog', () => {
    const install = readInstall();
    expect(install).toMatch(/debugLog.*config\.json|config\.json.*debugLog|debugLog.*agenfkConfigPath|agenfkConfigPath.*debugLog/);
  });

  it('should log rootDir and cwd under --debuglog', () => {
    const install = readInstall();
    expect(install).toMatch(/debugLog.*rootDir|rootDir.*debugLog|debugLog.*cwd|cwd.*debugLog/);
  });

  it('should log which dist directories are present or missing under --debuglog', () => {
    const install = readInstall();
    expect(install).toMatch(/debugLog.*missingDists|missingDists.*debugLog|debugLog.*dist.*missing|missing.*dist.*debugLog/i);
  });

  it('should log presence of src/ directories under --debuglog', () => {
    const install = readInstall();
    // Helps diagnose spurious source builds
    expect(install).toMatch(/debugLog.*staleSrc|staleSrc.*debugLog|debugLog.*src.*exist|exist.*src.*debugLog/i);
  });

  it('should log platform and WSL detection info under --debuglog', () => {
    const install = readInstall();
    expect(install).toMatch(/debugLog.*platform|platform.*debugLog|debugLog.*WSL|WSL.*debugLog/i);
  });

  it('should log whether a running agenfk server was detected under --debuglog', () => {
    const install = readInstall();
    // Helps diagnose the "connected to another distro's server" scenario
    expect(install).toMatch(/debugLog.*server|server.*debugLog|debugLog.*port|port.*debugLog/i);
  });

  it('should log the resolved dbPath after all resolution steps under --debuglog', () => {
    const install = readInstall();
    expect(install).toMatch(/debugLog.*dbPath|dbPath.*debugLog/);
  });
});

describe('CLI upgrade/up -- no --rebuild', () => {
  it('upgrade command should not have a --rebuild option', () => {
    const cli = readCli();
    const upgradeStart = cli.indexOf(".command('upgrade')");
    const upgradeEnd = cli.indexOf(".command('up')", upgradeStart);
    const upgradeSection = cli.slice(upgradeStart, upgradeEnd);
    expect(upgradeSection).not.toMatch(/option.*--rebuild|--rebuild.*rebuild/);
  });

  it('upgrade command should not pass --rebuild to install.mjs', () => {
    const cli = readCli();
    const upgradeStart = cli.indexOf(".command('upgrade')");
    const upgradeEnd = cli.indexOf(".command('up')", upgradeStart);
    const upgradeSection = cli.slice(upgradeStart, upgradeEnd);
    expect(upgradeSection).not.toMatch(/rebuildFlag|--rebuild/);
  });

  it('up command should not have a --rebuild option', () => {
    const cli = readCli();
    const upStart = cli.indexOf(".command('up')");
    const upEnd = cli.indexOf(".command('down')", upStart);
    const upSection = cli.slice(upStart, upEnd);
    expect(upSection).not.toMatch(/option.*--rebuild|options\.rebuild/);
  });

  it('up command should not pass --rebuild to install.mjs', () => {
    const cli = readCli();
    const upStart = cli.indexOf(".command('up')");
    const upEnd = cli.indexOf(".command('down')", upStart);
    const upSection = cli.slice(upStart, upEnd);
    expect(upSection).not.toMatch(/--rebuild/);
  });
});

describe('CLI upgrade --debuglog flag', () => {
  it('should accept --debuglog as a CLI option on the upgrade command', () => {
    const cli = readCli();
    const upgradeStart = cli.indexOf(".command('upgrade')");
    const upgradeEnd = cli.indexOf(".command('up')", upgradeStart);
    const upgradeSection = cli.slice(upgradeStart, upgradeEnd);
    expect(upgradeSection).toMatch(/--debuglog/);
  });

  it('should forward --debuglog to install.mjs when set', () => {
    const cli = readCli();
    const upgradeStart = cli.indexOf(".command('upgrade')");
    const upgradeEnd = cli.indexOf(".command('up')", upgradeStart);
    const upgradeSection = cli.slice(upgradeStart, upgradeEnd);
    // The install.mjs invocation must include --debuglog when the option is active
    expect(upgradeSection).toMatch(/debuglog.*install\.mjs|install\.mjs.*debuglog/i);
  });
});

const START_SERVICES_PATH = path.resolve(__dirname, '../../../../scripts/start-services.mjs');
const UI_PKG_PATH = path.resolve(__dirname, '../../../ui/package.json');
const VITE_CONFIG_PATH = path.resolve(__dirname, '../../../ui/vite.config.ts');

function readStartServices(): string {
  if (!fs.existsSync(START_SERVICES_PATH)) return '';
  return fs.readFileSync(START_SERVICES_PATH, 'utf8');
}
function readUiPkg(): Record<string, unknown> {
  if (!fs.existsSync(UI_PKG_PATH)) return {};
  return JSON.parse(fs.readFileSync(UI_PKG_PATH, 'utf8'));
}
function readViteConfig(): string {
  if (!fs.existsSync(VITE_CONFIG_PATH)) return '';
  return fs.readFileSync(VITE_CONFIG_PATH, 'utf8');
}

describe('UI vite preview fix', () => {
  it('start-services.mjs should use npm run preview, not npm run dev', () => {
    const content = readStartServices();
    expect(content).not.toMatch(/'run',\s*'dev'|"run",\s*"dev"/);
    expect(content).toMatch(/'run',\s*'preview'|"run",\s*"preview"/);
  });

  it('install.mjs start-services template should use npm run preview, not npm run dev', () => {
    const install = readInstall();
    const templateStart = install.indexOf('startScriptContent');
    const templateEnd = install.indexOf('startScriptPath', templateStart + 1);
    const template = install.slice(templateStart, templateEnd);
    expect(template).not.toMatch(/['"]run['"]\s*,\s*['"]dev['"]/);
    expect(template).toMatch(/['"]run['"]\s*,\s*['"]preview['"]/);
  });

  it('packages/ui/package.json should have a preview script', () => {
    const pkg = readUiPkg() as { scripts?: Record<string, string> };
    expect(pkg.scripts?.preview).toBeDefined();
    expect(pkg.scripts?.preview).toMatch(/vite preview/);
  });

  it('vite.config.ts should configure preview.port from VITE_PORT', () => {
    const config = readViteConfig();
    expect(config).toMatch(/preview\s*:\s*\{[^}]*port/);
    expect(config).toMatch(/VITE_PORT/);
  });
});
