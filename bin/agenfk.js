#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { compareSemver } from './version-utils.mjs';
import { pruneInstallDir, pruneInstallDirAgainstManifest } from './sync-install-dir.mjs';

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
// Refuse macOS metadata on the way IN. This is the path that actually polluted
// users: every published release up to v1.1.16-beta.4 was ~half AppleDouble
// (`._*`) entries, and this extraction lands the tarball straight into the
// install dir — after the filtered cpSync above, so that filter never sees it.
// Excluding here makes the outcome independent of any later sweep.
// (CGLAB-94 / issue #163)
const tarExcludes = "--exclude='._*' --exclude='.DS_Store'";
const tarFlags = process.platform === 'win32'
  ? `--force-local ${tarExcludes} -xzf`
  : `${tarExcludes} -xzf`;

// compareSemver gates the redownload-on-update downgrade guard. It is imported
// from ./version-utils.mjs (top of file) so prerelease ordering is correct
// (numeric identifiers compared numerically: 1.1.0-beta.10 > 1.1.0-beta.8). The
// previous inline copy compared prerelease strings lexically and pinned
// `npx … --beta` to beta.8.

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


// Never copy macOS AppleDouble / Finder metadata into the install dir. Releases
// packaged on macOS carried a `._<name>` twin for every file with an extended
// attribute; copied verbatim, they reached the skills sync and were surfaced as
// garbage skills in every agent session (CGLAB-94 / issue #163).
const isMacMetadata = (name) => name.startsWith('._') || name === '.DS_Store';
const copyFilter = (src) => !isMacMetadata(path.basename(src));
// Say what was pruned, and say what could not be — an upgrade that reports
// clean while the leak persists is the failure mode this whole fix exists for.
function reportPrune({ removed, failed }) {
  for (const rel of removed) console.log(`  Pruned (no longer shipped): ${rel}`);
  for (const f of failed) console.log(`${YELLOW}  Could not prune ${f.path}: ${f.reason}${RESET}`);
}

// Fallback path for Node builds without fs.cpSync: `cp -r` can't filter, so
// remove the artifacts after the fact.
function sweepMacMetadata(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (isMacMetadata(entry.name)) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
    } else if (entry.isDirectory()) {
      sweepMacMetadata(full);
    }
  }
}

if (isNpxCache) {
  const isUpdate = fs.existsSync(INSTALL_DIR);
  // Read the INSTALLED version BEFORE the overlay below replaces package.json
  // with REPO_ROOT's. Both downgrade guards compare against "what is installed",
  // and reading it AFTER the copy compared the npx ref with itself — so the
  // guard could not see a beta install newer than main, which is the one case
  // it exists for.
  const installedVersion = readLocalVersion(INSTALL_DIR);
  // Set when the release archive pruned the install dir, so the source-tree
  // fallback below does not prune a second time against a different ref.
  let prunedAgainstArchive = false;
  // Set whenever the install dir is NOT on a ref we may prune it against, so
  // the source-tree fallback must not run. (Named for the question it answers,
  // not for one of the reasons: "kept newer install" misdescribed the
  // download-failure case, which is how that path was missed.)
  let skipSourcePrune = false;

  if (isUpdate) {
    console.log(`${GREEN}Updating AgEnFK at ${INSTALL_DIR}...${RESET}`);
    // Copy the new files over the existing install AND prune what this version
    // no longer ships. A bare overlay left deleted files behind forever, and
    // install.mjs re-installed them into every client's global config — that is
    // how the repo-private /agenfk-release command kept coming back.
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true, filter: copyFilter });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)}/. ${JSON.stringify(INSTALL_DIR)}/`, { stdio: 'inherit', shell: true });
      sweepMacMetadata(INSTALL_DIR);
    }
  } else {
    console.log(`${GREEN}Installing AgEnFK to ${INSTALL_DIR}...${RESET}`);
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true, filter: copyFilter });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
      sweepMacMetadata(INSTALL_DIR);
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
      const localVersion = installedVersion;
      const remoteVersion = String(latestTag || '').replace(/^v/, '');
      if (localVersion && remoteVersion && compareSemver(remoteVersion, localVersion) < 0) {
        console.log(`${YELLOW}Skip: refusing to downgrade — local install is on a newer version (${localVersion}) than the resolved tag (${remoteVersion}). Pass --beta to track prereleases.${RESET}`);
        // And skip the prune entirely. The install dir is deliberately left on a
        // NEWER ref than either the resolved tag or REPO_ROOT (the npx git ref,
        // i.e. the default branch). Pruning it against main would delete every
        // command the newer prerelease adds that main lacks — the same failure
        // the archive fork below exists to prevent, one branch over.
        skipSourcePrune = true;
      } else {
        const archive = path.join(INSTALL_DIR, 'agenfk-dist.tar.gz');
        try {
        downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', archive);
        execSync(`tar ${tarFlags} "${toPosixPath(archive)}" -C "${toPosixPath(INSTALL_DIR)}"`, { stdio: 'inherit' });
        // Prune against the ARCHIVE, not against REPO_ROOT. REPO_ROOT is the
        // npx git ref (the default branch); the tarball is fetchLatestTag,
        // which is a DIFFERENT ref — betas are cut from release/vX.Y.Z-beta.N
        // branches. Pruning a beta tarball against main deletes any command the
        // beta adds that main lacks, so the install ships without a command it
        // ships. The archive is the last writer here, so it is the authority.
        try {
          if (isUpdate) {
            const listFlags = process.platform === 'win32' ? '--force-local -tzf' : '-tzf';
            const listing = execSync(`tar ${listFlags} "${toPosixPath(archive)}"`, { encoding: 'utf8' })
              .split('\n').filter(Boolean);
            reportPrune(pruneInstallDirAgainstManifest(INSTALL_DIR, listing));
            prunedAgainstArchive = true;
          }
        } catch (e) {
          // The download and extract SUCCEEDED; only the listing failed. Letting
          // this reach the outer catch printed "Failed to download pre-built
          // binary" and "Falling back to source-based installation", both false,
          // and then pruned against main anyway.
          console.error(`${YELLOW}Could not prune against the release archive: ${e.message}${RESET}`);
          skipSourcePrune = true; // don't fall back to a different ref
        }
        } finally {
          // Covers the download and the extract too, not just the listing: curl
          // writes a partial .tar.gz before failing, and that used to sit in the
          // install dir permanently.
          try { fs.unlinkSync(archive); } catch { /* already gone */ }
        }
      }
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
      // And do NOT prune. The existing install is on the tag the user already
      // has, which may be NEWER than REPO_ROOT (the npx git ref = the default
      // branch) — a prerelease, say. Unauthenticated api.github.com is rate
      // limited at 60/h, so fetchLatestTag throwing is routine, and pruning a
      // beta install against main would delete every command the beta adds.
      // Before this, that made a transient rate limit destructive where the
      // pre-change behaviour was a harmless no-op overlay.
      skipSourcePrune = true;
    }
  }

  // Only when the npx cache genuinely IS the last writer for PRUNED_DIRS —
  // i.e. --rebuild, where no archive was ever fetched. Every path where the
  // install dir might be on a different (or newer) ref sets skipSourcePrune.
  if (isUpdate && !prunedAgainstArchive && !skipSourcePrune) {
    // Same downgrade guard the archive path applies above, and for the same
    // reason: REPO_ROOT is the npx git ref (the default branch), while a beta
    // install sits on a newer prerelease. Deleting the files this ref lacks
    // would strip every command the newer tag ships — the failure the archive
    // fork exists to prevent. (--rebuild skips the download block entirely, so
    // it never reached that guard.)
    const sourceVersion = readLocalVersion(REPO_ROOT);
    if (installedVersion && sourceVersion && compareSemver(sourceVersion, installedVersion) < 0) {
      console.log(`${YELLOW}Skip: not pruning — the install is on a newer version (${installedVersion}) than this source tree (${sourceVersion}).${RESET}`);
    } else {
      reportPrune(pruneInstallDir(REPO_ROOT, INSTALL_DIR));
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
