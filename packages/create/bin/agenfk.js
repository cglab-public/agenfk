#!/usr/bin/env node

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_URL = 'https://github.com/cglab-public/agenfk.git';
const INSTALL_DIR = path.join(os.homedir(), '.agenfk-system');

const GREEN = '\x1b[32m';
const BLUE  = '\x1b[34m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';

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

// Check git is available
const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
if (gitCheck.status !== 0) {
  console.error('Error: git is required but not found. Please install git and try again.');
  process.exit(1);
}

const shouldRebuild = process.argv.includes('--rebuild');
const REPO_NAME = 'cglab-public/agenfk';

// The stable release to install (BUG 4bd98e16). GitHub's /releases/latest and
// `gh release view` pick by DATE and include hub image releases (`hub-v*`)
// published without --prerelease, so either is only one candidate beside the
// release list; the newest framework stable by VERSION wins. Same rule as the
// CLI's newestChannelRelease and bin/version-utils.mjs's newestChannelTag -
// copied, because this published package is a single file.
function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}
function compareSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x.localeCompare(y);
  }
  return 0;
}
function newestStableTag(tags) {
  const stable = tags.filter((t) => t && !/^hub-v/i.test(t) && parseSemver(t) && parseSemver(t).pre.length === 0);
  return stable.sort((a, b) => compareSemver(b, a))[0] || null;
}
function fetchLatestTag(repo) {
  // GitHub's own answer first, the list best-effort (the CLI's order): a list
  // that fails never throws away a good /releases/latest. maxBuffer: the
  // 100-release list grows with every release's notes; the default is 1 MB.
  const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const curlJson = (url) => JSON.parse(run(`curl -fsSL "${url}" -H "Accept: application/vnd.github+json" -H "User-Agent: agenfk-installer"`));
  const viaApi = () => {
    const tags = [];
    try { tags.push(curlJson(`https://api.github.com/repos/${repo}/releases/latest`).tag_name); } catch { /* the list decides */ }
    try {
      const list = curlJson(`https://api.github.com/repos/${repo}/releases?per_page=100`);
      for (const r of Array.isArray(list) ? list : []) if (r && !r.prerelease) tags.push(r.tag_name);
    } catch { /* latest decides */ }
    return newestStableTag(tags);
  };
  const viaGh = () => {
    const tags = [];
    try { tags.push(run(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`).trim()); } catch { /* the list decides */ }
    try {
      const rows = JSON.parse(run(`gh release list --repo ${repo} --limit 100 --exclude-drafts --json tagName,isPrerelease`) || '[]');
      for (const r of rows) if (r && !r.isPrerelease) tags.push(r.tagName);
    } catch { /* the viewed tag decides */ }
    return newestStableTag(tags);
  };
  const tag = viaApi() || viaGh();
  if (!tag) {
    throw new Error(`Could not resolve a stable framework release for ${repo}: `
      + 'the GitHub API and gh both failed, or the repo lists only hub releases.');
  }
  return tag;
}

// Download release asset — direct curl URL (no auth) first, gh CLI as fallback
function downloadAsset(repo, tag, pattern, outputPath) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${pattern}`;
  try {
    execSync(`curl -fsSL "${url}" -o "${outputPath}"`, { stdio: 'inherit', windowsHide: true });
    return;
  } catch {}
  // Fallback: gh CLI
  execSync(`gh release download ${tag} --repo ${repo} --pattern '${pattern}' --output "${outputPath}"`, { stdio: 'inherit', windowsHide: true });
}

// Archive kept alive until install.mjs has run. `tar -xzf` deletes nothing, so
// the install dir still holds files this version dropped, and the only
// non-circular authority on what is current is the archive listing (the install
// dir IS the stale thing). This file is what `npx agenfk@latest` actually runs —
// the root package is private and packages/create is the published `agenfk` —
// so leaving it out left the highest-traffic upgrade route unfixed.
//
// Deliberately NOT pruned on the two no-archive routes, and this is a stated
// limitation rather than an oversight:
//   - `isGitRepo` (a clone): `git pull` above already applies upstream DELETIONS
//     to tracked files, so the install dir is not stale in the first place.
//   - `--rebuild` on a NON-git install: there is no archive and no source tree to
//     diff against, so there is NO authority for what this version ships. Pruning
//     against a guess would delete files the install legitimately needs. The
//     repo-private release commands are still suppressed there by the copy-site
//     filter (isRepoPrivateCommand); any OTHER file deleted upstream can persist
//     on that one dev-oriented route until a reinstall.
let distTarball = null;

if (fs.existsSync(INSTALL_DIR)) {
  console.log(`${GREEN}AgEnFK already installed at ${INSTALL_DIR}${RESET}`);
  const isGitRepo = fs.existsSync(path.join(INSTALL_DIR, '.git'));

  if (isGitRepo) {
    console.log('Pulling latest changes...');
    execSync('git pull', { cwd: INSTALL_DIR, stdio: 'inherit', windowsHide: true });
  } else if (!shouldRebuild) {
    console.log(`${GREEN}Updating pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = fetchLatestTag(REPO_NAME);
      downloadAsset(REPO_NAME, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit', windowsHide: true });
      distTarball = path.join(INSTALL_DIR, 'agenfk-dist.tar.gz');
    } catch (e) {
      console.error(`Failed to update pre-built binary: ${e.message}`);
      // curl writes a partial .tar.gz before failing, and a failed extract
      // leaves the whole archive behind — either way it would sit in the
      // install dir permanently, since only the success path records it for
      // cleanup below.
      try { fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')); } catch { /* not there */ }
    }
  }
} else {
  if (!shouldRebuild) {
    console.log(`Installing pre-built AgEnFK to ${INSTALL_DIR} ...`);
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    try {
      const latestTag = fetchLatestTag(REPO_NAME);
      downloadAsset(REPO_NAME, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit', windowsHide: true });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      try { fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')); } catch { /* not there */ }
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to git clone...${RESET}`);
      execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true, windowsHide: true });
    }
  } else {
    console.log(`Cloning AgEnFK to ${INSTALL_DIR} ...`);
    execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true, windowsHide: true });
  }
}

console.log(`\n${GREEN}Running install...${RESET}\n`);
const tarballEnv = distTarball && fs.existsSync(distTarball) ? distTarball : null;
try {
  execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}`, {
    cwd: INSTALL_DIR,
    stdio: 'inherit',
    // Path via env, never interpolated into the command string: a filesystem
    // path is not shell-safe (see scripts/install.mjs).
    env: { ...process.env, ...(tarballEnv ? { AGENFK_DIST_TARBALL: tarballEnv } : {}) },
    windowsHide: true,
  });
} finally {
  if (distTarball) { try { fs.unlinkSync(distTarball); } catch { /* already gone */ } }
}
