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
                         __ _
                        / _| |
  __ _  __ _  ___ _ __ | |_| | __
 / _\` |/ _\` |/ _ \\ '_ \\|  _| |/ /
| (_| | (_| |  __/ | | | | |   <
 \\__,_|\\__, |\\___|_| |_|_| |_|\\_\\
        __/ |
       |___/
${RESET}`);

console.log(`${BLUE}=== AgenFK Installer ===${RESET}\n`);

// Determine whether we're running from the npx cache or a real clone.
// A real clone has a .git directory; the npx cache does not.
const isNpxCache = !fs.existsSync(path.join(REPO_ROOT, '.git'));
const shouldRebuild = process.argv.includes('--rebuild');

if (isNpxCache) {
  if (fs.existsSync(INSTALL_DIR)) {
    console.log(`${GREEN}Updating AgenFK at ${INSTALL_DIR}...${RESET}`);
    // Overlay new files from the npx cache onto the existing install
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)}/. ${JSON.stringify(INSTALL_DIR)}/`, { stdio: 'inherit', shell: true });
    }
  } else {
    console.log(`${GREEN}Installing AgenFK to ${INSTALL_DIR}...${RESET}`);
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
    }
  }

  const distMissing = !fs.existsSync(path.join(INSTALL_DIR, 'packages/cli/dist')) || !fs.existsSync(path.join(INSTALL_DIR, 'packages/server/dist'));
  if (!shouldRebuild && distMissing) {
    const REPO = 'cglab-PRIVATE/agenfk';
    console.log(`${GREEN}Downloading pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = execSync(`gh release view --repo ${REPO} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
      execSync(`gh release download ${latestTag} --repo ${REPO} --pattern 'agenfk-dist.tar.gz' --output "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}"`, { stdio: 'inherit' });
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  console.log(`\n${GREEN}Running setup from ${INSTALL_DIR}...${RESET}\n`);
  execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}`, { cwd: INSTALL_DIR, stdio: 'inherit' });
} else {
  // Running from a real git clone — install in place
  console.log(`${GREEN}Running install from ${REPO_ROOT}...${RESET}\n`);
  
  const distMissing = !fs.existsSync(path.join(REPO_ROOT, 'packages/cli/dist')) || !fs.existsSync(path.join(REPO_ROOT, 'packages/server/dist'));
  if (!shouldRebuild && distMissing) {
    const REPO = 'cglab-PRIVATE/agenfk';
    console.log(`${GREEN}Downloading pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = execSync(`gh release view --repo ${REPO} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
      execSync(`gh release download ${latestTag} --repo ${REPO} --pattern 'agenfk-dist.tar.gz' --output "${path.join(REPO_ROOT, 'agenfk-dist.tar.gz')}"`, { stdio: 'inherit' });
      execSync(`tar -xzf "${path.join(REPO_ROOT, 'agenfk-dist.tar.gz')}" -C "${REPO_ROOT}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}`, { cwd: REPO_ROOT, stdio: 'inherit' });
}
