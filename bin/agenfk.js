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
  console.log(`\n${GREEN}Running setup from ${INSTALL_DIR}...${RESET}\n`);
  execSync('node scripts/install.mjs', { cwd: INSTALL_DIR, stdio: 'inherit' });
} else {
  // Running from a real git clone — install in place
  console.log(`${GREEN}Running install from ${REPO_ROOT}...${RESET}\n`);
  execSync('node scripts/install.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
}
