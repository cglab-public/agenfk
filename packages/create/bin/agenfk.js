#!/usr/bin/env node

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_URL = 'https://github.com/cglab-PRIVATE/agenfk.git';
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

if (fs.existsSync(INSTALL_DIR)) {
  console.log(`${GREEN}AgenFK already installed at ${INSTALL_DIR}${RESET}`);
  console.log('Pulling latest changes...');
  execSync('git pull', { cwd: INSTALL_DIR, stdio: 'inherit' });
} else {
  console.log(`Cloning AgenFK to ${INSTALL_DIR} ...`);
  execSync(`git clone ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`, { stdio: 'inherit', shell: true });
}

console.log(`\n${GREEN}Running install...${RESET}\n`);
execSync('node scripts/install.mjs', { cwd: INSTALL_DIR, stdio: 'inherit' });
