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

// Check git is available
const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitCheck.status !== 0) {
  console.error('Error: git is required but not found. Please install git and try again.');
  process.exit(1);
}

const shouldRebuild = process.argv.includes('--rebuild');
const REPO_NAME = 'cglab-public/agenfk';

if (fs.existsSync(INSTALL_DIR)) {
  console.log(`${GREEN}AgenFK already installed at ${INSTALL_DIR}${RESET}`);
  const isGitRepo = fs.existsSync(path.join(INSTALL_DIR, '.git'));
  
  if (isGitRepo) {
    console.log('Pulling latest changes...');
    execSync('git pull', { cwd: INSTALL_DIR, stdio: 'inherit' });
  } else if (!shouldRebuild) {
    console.log(`${GREEN}Updating pre-built binary from GitHub...${RESET}`);
    try {
      const latestTag = execSync(`gh release view --repo ${REPO_NAME} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
      execSync(`gh release download ${latestTag} --repo ${REPO_NAME} --pattern 'agenfk-dist.tar.gz' --output "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}"`, { stdio: 'inherit' });
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to update pre-built binary: ${e.message}`);
    }
  }
} else {
  if (!shouldRebuild) {
    console.log(`Installing pre-built AgenFK to ${INSTALL_DIR} ...`);
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    try {
      const latestTag = execSync(`gh release view --repo ${REPO_NAME} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
      execSync(`gh release download ${latestTag} --repo ${REPO_NAME} --pattern 'agenfk-dist.tar.gz' --output "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}"`, { stdio: 'inherit' });
      execSync(`tar -xzf "${path.join(INSTALL_DIR, 'agenfk-dist.tar.gz')}" -C "${INSTALL_DIR}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(INSTALL_DIR, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to git clone...${RESET}`);
      execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
    }
  } else {
    console.log(`Cloning AgenFK to ${INSTALL_DIR} ...`);
    execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
  }
}

console.log(`\n${GREEN}Running install...${RESET}\n`);
execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}`, { cwd: INSTALL_DIR, stdio: 'inherit' });
