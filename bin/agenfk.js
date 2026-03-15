#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(os.homedir(), '.agenfk-system');

const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const BLUE  = '\x1b[34m';
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

// Determine whether we're running from the npx cache or a real clone.
// A real clone has a .git directory; the npx cache does not.
const isNpxCache = !fs.existsSync(path.join(REPO_ROOT, '.git'));
const shouldRebuild = process.argv.includes('--rebuild');
const isBeta = process.argv.includes('--beta');

// On Windows, BSD tar treats "C:" as a remote hostname; the force-local flag disables that.
const tarFlags = process.platform === 'win32' ? '--force-local -xzf' : '-xzf';

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
      downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
      execSync(`tar ${tarFlags} "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  console.log(`\n${GREEN}Running setup from ${INSTALL_DIR}...${RESET}\n`);
  execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}${isBeta ? ' --beta' : ''}`, { cwd: INSTALL_DIR, stdio: 'inherit' });
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
      execSync(`tar ${tarFlags} "${path.join(REPO_ROOT, 'agenfk-dist.tar.gz')}" -C "${REPO_ROOT}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}${isBeta ? ' --beta' : ''}`, { cwd: REPO_ROOT, stdio: 'inherit' });
}

// Final reminder — always shown so it's visible at the end of install output
if (process.platform !== 'win32') {
  const shell = process.env.SHELL ? path.basename(process.env.SHELL) : '';
  const sourceHint = shell === 'zsh' ? 'source ~/.zshrc'
    : shell === 'bash' ? 'source ~/.bashrc'
    : shell === 'fish' ? 'source ~/.config/fish/config.fish'
    : 'source your shell rc file';
  console.log(`\n${GREEN}✅ AgEnFK installation complete!${RESET}`);
  console.log(`\n${CYAN}  To use the 'agenfk' command in this terminal, run:${RESET}`);
  console.log(`${CYAN}    ${sourceHint}${RESET}`);
  console.log(`\n${CYAN}  Then start services with: agenfk up${RESET}\n`);
}
