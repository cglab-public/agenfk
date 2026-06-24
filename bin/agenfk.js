#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(os.homedir(), '.agenfk-system');

const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const BLUE   = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

console.log(`${CYAN}
                     ______           ______   _  __
     /\\             |  ____|         |  ____| | |/ /
    /  \\      __ _  | |__     _ __   | |__    | ' /
   / /\\ \\    / _\` | |  __|   | '_ \\  |  __|   |  <
  / ____ \\  | (_| | | |____  | | | | | |      | . \\
 /_/    \\_\\  \\__, | |______| |_| |_| |_|      |_|\\_\\
              __/ |
             |___/
${RESET}`);

console.log(`${BLUE}=== AgEnFK Installer ===${RESET}\n`);

// Determine whether we're running from the npx cache or a real clone.
// A real clone has a .git directory; the npx cache does not.
const isNpxCache = !fs.existsSync(path.join(REPO_ROOT, '.git'));
const shouldRebuild = process.argv.includes('--rebuild');
const isBeta = process.argv.includes('--beta');
// MCP is opt-in (CLI-only by default): forward --with-mcp / --no-mcp to install.mjs.
const withMcp = process.argv.includes('--with-mcp');
const noMcp = process.argv.includes('--no-mcp');

// SAFETY GUARD: this is the npx *installer bootstrap*, not the CLI dispatcher.
// Run against a git checkout it installs in place, and scripts/install.mjs's
// cleanStaleSrc step would DELETE packages/*/src. Refuse on ANY git working tree
// (a `.git` dir — the same signal `isNpxCache` keys off; the npx cache has none)
// unless explicitly forced. `hasSrc` only sharpens the warning.
const hasGit = fs.existsSync(path.join(REPO_ROOT, '.git'));
const hasSrc = fs.existsSync(path.join(REPO_ROOT, 'packages', 'cli', 'src'));
const forceInstall = process.argv.includes('--force-install');
if (hasGit && !forceInstall) {
  console.error(`${YELLOW}❌ Refusing to run the AgEnFK installer bootstrap from a source checkout.${RESET}`);
  console.error(`   This entry point (bin/agenfk.js) installs in place${hasSrc ? ` and would DELETE your\n   ${REPO_ROOT}/packages/*/src directories (via install.mjs cleanStaleSrc)` : ''}.\n`);
  console.error(`   If you meant to run a CLI command, use the dispatcher: ${CYAN}agenfk <command>${RESET}`);
  console.error(`   If you really want to (re)install from this clone: ${CYAN}npm run install:framework${RESET}`);
  console.error(`   To override this guard anyway: ${CYAN}node bin/agenfk.js --force-install${RESET}\n`);
  process.exit(1);
}

// On MSYS2 / Git-for-Windows (MinGW), Node.js reports process.platform === 'win32' but
// the bundled tar is an MSYS2 binary that understands POSIX paths (/c/Users/...).
// Converting Win32 paths to POSIX form avoids the "C: treated as remote hostname" error
// even when --force-local is not supported or not respected by the installed tar version.
const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX ||
  (process.platform === 'win32' && process.env.SHELL?.includes('bash')));

// Convert a Win32 drive path to an MSYS2 POSIX path (/c/Users/...) so that
// MSYS2 tar never sees a bare "C:" that it might interpret as a remote hostname.
function toPosixPath(p) {
  if (isMinGW && /^[a-zA-Z]:/.test(p)) {
    return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  return p;
}

// On Windows, BSD tar treats "C:" as a remote hostname; --force-local disables that.
// On MinGW we also convert paths to POSIX form as a belt-and-suspenders measure.
const tarFlags = process.platform === 'win32' ? '--force-local -xzf' : '-xzf';

// Semver comparator gating the redownload-on-update path. Returns negative,
// zero, or positive following semver ordering, with the prerelease rule that
// a release is greater than its prerelease (1.0.0 > 1.0.0-rc.1).
function compareSemver(a, b) {
  const parse = (s) => {
    const m = String(s || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
  };
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === '' && pb.pre !== '') return 1;
  if (pa.pre !== '' && pb.pre === '') return -1;
  return pa.pre.localeCompare(pb.pre);
}

// Read the local install's version. Returns null if the file is missing or unreadable.
function readLocalVersion(installDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : null;
  } catch { return null; }
}

// Fetch latest release tag — curl (no auth) first, gh CLI as fallback.
// When beta=true, fetches all recent releases and picks the most recently published
// (including pre-releases), mirroring the behaviour of `agenfk upgrade --beta`.
function fetchLatestTag(repo, beta = false) {
  try {
    const url = beta
      ? `https://api.github.com/repos/${repo}/releases?per_page=20`
      : `https://api.github.com/repos/${repo}/releases/latest`;
    const json = execSync(
      `curl -fsSL "${url}" -H "Accept: application/vnd.github+json" -H "User-Agent: agenfk-installer"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const data = JSON.parse(json);
    const tag = beta
      ? (Array.isArray(data) ? data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]?.tag_name : null)
      : data.tag_name;
    if (tag) return tag;
  } catch {}
  // Fallback: gh CLI
  if (beta) {
    return execSync(`gh release list --repo ${repo} --limit 1 --json tagName --template '{{range .}}{{.tagName}}{{end}}'`, { encoding: 'utf8' }).trim();
  }
  return execSync(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
}

// Run the setup script, surfacing a clean failure instead of letting the success
// banner print on a partial/failed install (issue #86 #3). execSync throws on a
// non-zero exit; we translate that into an explicit error + non-zero exit code.
function runInstaller(cwd) {
  try {
    execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}${isBeta ? ' --beta' : ''}${withMcp ? ' --with-mcp' : ''}${noMcp ? ' --no-mcp' : ''}`, { cwd, stdio: 'inherit' });
  } catch {
    console.error(`\n${YELLOW}❌ AgEnFK installation failed — the setup step did not complete.${RESET}`);
    console.error(`${YELLOW}   See the output above for the failing step, then re-run:${RESET}`);
    console.error(`${YELLOW}     npx -p github:cglab-public/agenfk agenfk${RESET}\n`);
    process.exit(1);
  }
}

// Download release asset — direct curl URL (no auth) first, gh CLI as fallback
function downloadAsset(repo, tag, pattern, outputPath) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${pattern}`;
  try {
    execSync(`curl -fsSL "${url}" -o "${outputPath}"`, { stdio: 'inherit' });
    return;
  } catch {}
  // Fallback: gh CLI
  execSync(`gh release download ${tag} --repo ${repo} --pattern '${pattern}' --output "${outputPath}"`, { stdio: 'inherit' });
}

if (isNpxCache) {
  const isUpdate = fs.existsSync(INSTALL_DIR);

  if (isUpdate) {
    console.log(`${GREEN}Updating AgEnFK at ${INSTALL_DIR}...${RESET}`);
    // Overlay new files from the npx cache onto the existing install
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)}/. ${JSON.stringify(INSTALL_DIR)}/`, { stdio: 'inherit', shell: true });
    }
  } else {
    console.log(`${GREEN}Installing AgEnFK to ${INSTALL_DIR}...${RESET}`);
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
    }
  }

  const distMissing = !fs.existsSync(path.join(INSTALL_DIR, 'packages/cli/dist')) || !fs.existsSync(path.join(INSTALL_DIR, 'packages/server/dist'));
  // Always download on update (to replace stale binaries); on fresh install only if dist missing
  if (!shouldRebuild && (isUpdate || distMissing)) {
    const REPO = 'cglab-public/agenfk';
    console.log(`${GREEN}Downloading pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = fetchLatestTag(REPO, isBeta);
      // Downgrade guard: refuse to extract a tag whose version is older than
      // the existing install. Without this, `npx github:cglab-public/agenfk`
      // (no --beta) on a beta install resolves to the latest *stable* tag,
      // which is older than the local prerelease, and tar -xzf silently
      // reverts the install. (Bug 28635f38.)
      const localVersion = readLocalVersion(INSTALL_DIR);
      const remoteVersion = String(latestTag || '').replace(/^v/, '');
      if (localVersion && remoteVersion && compareSemver(remoteVersion, localVersion) < 0) {
        console.log(`${YELLOW}Skip: refusing to downgrade — local install is on a newer version (${localVersion}) than the resolved tag (${remoteVersion}). Pass --beta to track prereleases.${RESET}`);
      } else {
        downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
        execSync(`tar ${tarFlags} "${toPosixPath(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'))}" -C "${toPosixPath(INSTALL_DIR)}"`, { stdio: 'inherit' });
        fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      }
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  console.log(`\n${GREEN}Running setup from ${INSTALL_DIR}...${RESET}\n`);
  runInstaller(INSTALL_DIR);
} else {
  // Running from a real git clone — install in place
  console.log(`${GREEN}Running install from ${REPO_ROOT}...${RESET}\n`);

  const distMissing = !fs.existsSync(path.join(REPO_ROOT, 'packages/cli/dist')) || !fs.existsSync(path.join(REPO_ROOT, 'packages/server/dist'));
  if (!shouldRebuild && distMissing) {
    const REPO = 'cglab-public/agenfk';
    console.log(`${GREEN}Downloading pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = fetchLatestTag(REPO, isBeta);
      downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
      execSync(`tar ${tarFlags} "${toPosixPath(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'))}" -C "${toPosixPath(REPO_ROOT)}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  runInstaller(REPO_ROOT);
}

// Reached only when the setup script above exited 0 (runInstaller exits non-zero on
// failure). The PATH / "source <rc>" guidance is printed conditionally by install.mjs
// itself — it knows whether an rc file was actually modified — so we don't repeat a
// (potentially misleading) source hint here (issue #86 #3/#4).
if (process.platform !== 'win32') {
  console.log(`\n${GREEN}✅ AgEnFK installation complete!${RESET}`);
  console.log(`\n${CYAN}  Once 'agenfk' is on your PATH, start services with: agenfk up${RESET}\n`);
}
