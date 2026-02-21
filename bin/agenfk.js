#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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
console.log(`${GREEN}Running install from ${REPO_ROOT}...${RESET}\n`);

execSync('./install.sh', { cwd: REPO_ROOT, stdio: 'inherit' });
