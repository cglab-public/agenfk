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
const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitCheck.status !== 0) {
  console.error('Error: git is required but not found. Please install git and try again.');
  process.exit(1);
}

const shouldRebuild = process.argv.includes('--rebuild');
const REPO_NAME = 'cglab-public/agenfk';

// Fetch latest release tag — curl (no auth) first, gh CLI as fallback
function fetchLatestTag(repo) {
  try {
    const json = execSync(
      `curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" -H "Accept: application/vnd.github+json" -H "User-Agent: agenfk-installer"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const tag = JSON.parse(json).tag_name;
    if (tag) return tag;
  } catch {}
  // Fallback: gh CLI
  return execSync(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
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

if (fs.existsSync(INSTALL_DIR)) {
  console.log(`${GREEN}AgEnFK already installed at ${INSTALL_DIR}${RESET}`);
  const isGitRepo = fs.existsSync(path.join(INSTALL_DIR, '.git'));

  if (isGitRepo) {
    console.log('Pulling latest changes...');
    execSync('git pull', { cwd: INSTALL_DIR, stdio: 'inherit' });
  } else if (!shouldRebuild) {
    console.log(`${GREEN}Updating pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = fetchLatestTag(REPO_NAME);
      downloadAsset(REPO_NAME, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to update pre-built binary: ${e.message}`);
    }
  }
} else {
  if (!shouldRebuild) {
    console.log(`Installing pre-built AgEnFK to ${INSTALL_DIR} ...`);
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    try {
      const latestTag = fetchLatestTag(REPO_NAME);
      downloadAsset(REPO_NAME, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to git clone...${RESET}`);
      execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
    }
  } else {
    console.log(`Cloning AgEnFK to ${INSTALL_DIR} ...`);
    execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
  }
}

console.log(`\n${GREEN}Running install...${RESET}\n`);
execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}`, { cwd: INSTALL_DIR, stdio: 'inherit' });
