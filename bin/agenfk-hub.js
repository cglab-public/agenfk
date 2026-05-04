#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SYSTEM_DIR = path.join(os.homedir(), '.agenfk-system');

const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const BLUE  = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const isNpxCache = !fs.existsSync(path.join(REPO_ROOT, '.git'));
const shouldRebuild = process.argv.includes('--rebuild');
const isBeta = process.argv.includes('--beta');

const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX ||
  (process.platform === 'win32' && process.env.SHELL?.includes('bash')));

function toPosixPath(p) {
  if (isMinGW && /^[a-zA-Z]:/.test(p)) {
    return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  return p;
}

const tarFlags = process.platform === 'win32' ? '--force-local -xzf' : '-xzf';

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
  if (beta) {
    return execSync(`gh release list --repo ${repo} --limit 1 --json tagName --template '{{range .}}{{.tagName}}{{end}}'`, { encoding: 'utf8' }).trim();
  }
  return execSync(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
}

function downloadAsset(repo, tag, pattern, outputPath) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${pattern}`;
  try {
    execSync(`curl -fsSL "${url}" -o "${outputPath}"`, { stdio: 'inherit' });
    return;
  } catch {}
  execSync(`gh release download ${tag} --repo ${repo} --pattern '${pattern}' --output "${outputPath}"`, { stdio: 'inherit' });
}

function startHub(baseDir) {
  const binPath = path.join(baseDir, 'packages/hub/dist/bin.js');
  if (!fs.existsSync(binPath)) {
    console.error(`\n${YELLOW}Hub binary not found at ${binPath}.${RESET}`);
    console.error(`Run with --rebuild to force a fresh build.\n`);
    process.exit(1);
  }

  const missing = [];
  if (!process.env.AGENFK_HUB_SECRET_KEY)     missing.push('AGENFK_HUB_SECRET_KEY');
  if (!process.env.AGENFK_HUB_SESSION_SECRET)  missing.push('AGENFK_HUB_SESSION_SECRET');
  if (missing.length) {
    console.error(`\n${YELLOW}Missing required environment variables:${RESET}`);
    missing.forEach(v => console.error(`  ${v}`));
    console.error(`\nExample:`);
    console.error(`  export AGENFK_HUB_SECRET_KEY="$(openssl rand -hex 32)"`);
    console.error(`  export AGENFK_HUB_SESSION_SECRET="$(openssl rand -hex 32)"`);
    console.error(`  export AGENFK_HUB_INITIAL_ADMIN_EMAIL=you@example.com`);
    console.error(`  export AGENFK_HUB_INITIAL_ADMIN_PASSWORD=changeme123\n`);
    process.exit(1);
  }

  const port = process.env.AGENFK_HUB_PORT || '4000';
  console.log(`\n${GREEN}Starting AgEnFK Hub on port ${port}...${RESET}`);
  console.log(`${CYAN}  Open http://localhost:${port}/ in your browser${RESET}\n`);

  const child = spawn(process.execPath, [binPath], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: baseDir,
  });
  child.on('exit', code => process.exit(code ?? 0));
}

console.log(`${CYAN}
  _   _       _       ______    _   _   _____   _  __
 | | | |     | |     |  ____|  | \\ | | |  ___| | |/ /
 | |_| |_   _| |__   | |__     |  \\| | | |_    | ' /
 |  _  | | | | '_ \\  |  __|    | . \` | |  _|   |  <
 | | | | |_| | |_) | | |____   | |\\  | | |     | . \\
 |_| |_|\\__,_|_.__/  |______|  |_| \\_| |_|     |_|\\_\\
${RESET}`);
console.log(`${BLUE}=== AgEnFK Hub ===${RESET}\n`);

if (!isNpxCache) {
  // Running from a real git clone — build if needed then start
  const hubDist = path.join(REPO_ROOT, 'packages/hub/dist/bin.js');
  if (shouldRebuild || !fs.existsSync(hubDist)) {
    console.log(`${GREEN}Building hub from source...${RESET}`);
    execSync('npm run build -w packages/core -w packages/storage-sqlite -w packages/hub', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  startHub(REPO_ROOT);
} else {
  // Running from npx cache — prefer existing ~/.agenfk-system install, else set up fresh
  const installDir = fs.existsSync(SYSTEM_DIR) ? SYSTEM_DIR : path.join(os.homedir(), '.agenfk-hub');
  const hubDist = path.join(installDir, 'packages/hub/dist/bin.js');
  const needsDist = shouldRebuild || !fs.existsSync(hubDist);

  if (!fs.existsSync(installDir)) {
    console.log(`${GREEN}Installing AgEnFK Hub to ${installDir}...${RESET}`);
    if (fs.cpSync) {
      fs.cpSync(REPO_ROOT, installDir, { recursive: true });
    } else {
      execSync(`cp -r ${JSON.stringify(REPO_ROOT)}/. ${JSON.stringify(installDir)}/`, { stdio: 'inherit', shell: true });
    }
  }

  if (needsDist) {
    const REPO = 'cglab-public/agenfk';
    console.log(`${GREEN}Downloading pre-built hub binary from GitHub...${RESET}`);
    try {
      const tag = fetchLatestTag(REPO, isBeta);
      downloadAsset(REPO, tag, 'agenfk-dist.tar.gz', path.join(installDir, 'agenfk-dist.tar.gz'));
      execSync(`tar ${tarFlags} "${toPosixPath(path.join(installDir, 'agenfk-dist.tar.gz'))}" -C "${toPosixPath(installDir)}"`, { stdio: 'inherit' });
      fs.unlinkSync(path.join(installDir, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`${YELLOW}Failed to download pre-built binary: ${e.message}${RESET}`);
      console.log(`${BLUE}Falling back to source build...${RESET}`);
      execSync('npm run build -w packages/core -w packages/storage-sqlite -w packages/hub', { cwd: installDir, stdio: 'inherit' });
    }
  }

  startHub(installDir);
}
