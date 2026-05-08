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

// HTTP helper — uses Node's built-in fetch (Node ≥18, required by engines).
// Falls back to curl, then gh CLI, so installs still work on systems missing
// any one of them.
async function fetchJson(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agenfk-installer' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const out = execSync(
    `curl -fsSL "${url}" -H "Accept: application/vnd.github+json" -H "User-Agent: agenfk-installer"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out);
}

async function fetchLatestTagAsync(repo, beta = false) {
  try {
    const url = beta
      ? `https://api.github.com/repos/${repo}/releases?per_page=20`
      : `https://api.github.com/repos/${repo}/releases/latest`;
    const data = await fetchJson(url);
    const tag = beta
      ? (Array.isArray(data) ? data.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]?.tag_name : null)
      : data.tag_name;
    if (tag) return tag;
  } catch (e) {
    console.error(`${YELLOW}[hub] HTTP tag lookup failed (${e.message}); trying gh CLI...${RESET}`);
  }
  // gh CLI fallback (only reachable when both fetch + curl failed).
  if (beta) {
    return execSync(`gh release list --repo ${repo} --limit 1 --json tagName --template '{{range .}}{{.tagName}}{{end}}'`, { encoding: 'utf8' }).trim();
  }
  return execSync(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`, { encoding: 'utf8' }).trim();
}

// Sync wrapper to keep the existing call-sites simple. We synchronously block
// on the async fetch via deasync-style polling — but that's ugly. Instead,
// flip the calling site to async/await.
function fetchLatestTag(repo, beta = false) {
  // Used by the legacy synchronous flow; preserved as a thin wrapper that
  // throws if the async tag lookup didn't already populate this value.
  // Callers that need the result pre-resolved should use fetchLatestTagAsync.
  throw new Error('fetchLatestTag is deprecated — use fetchLatestTagAsync.');
}

async function downloadAsset(repo, tag, pattern, outputPath) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${pattern}`;
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'agenfk-installer' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outputPath, buf);
      return;
    } catch (e) {
      console.error(`${YELLOW}[hub] fetch download failed (${e.message}); trying curl...${RESET}`);
    }
  }
  try {
    execSync(`curl -fsSL "${url}" -o "${outputPath}"`, { stdio: 'inherit' });
    return;
  } catch {}
  execSync(`gh release download ${tag} --repo ${repo} --pattern '${pattern}' --output "${outputPath}"`, { stdio: 'inherit' });
}

function ensureHubDeps(baseDir) {
  const hubNodeModules = path.join(baseDir, 'packages/hub/node_modules/cookie-parser');
  const rootNodeModules = path.join(baseDir, 'node_modules/cookie-parser');
  if (fs.existsSync(hubNodeModules) || fs.existsSync(rootNodeModules)) return;

  console.log(`${GREEN}Installing hub runtime dependencies...${RESET}`);
  try {
    execSync('npm install -w packages/hub --omit=dev --no-audit --no-fund', {
      cwd: baseDir,
      stdio: 'inherit',
    });
  } catch {
    console.log(`${YELLOW}Workspace install failed; falling back to flat install in packages/hub...${RESET}`);
    execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
      cwd: path.join(baseDir, 'packages/hub'),
      stdio: 'inherit',
    });
  }
}

function startHub(baseDir) {
  const binPath = path.join(baseDir, 'packages/hub/dist/bin.js');
  if (!fs.existsSync(binPath)) {
    console.error(`\n${YELLOW}Hub binary not found at ${binPath}.${RESET}`);
    console.error(`The downloaded release tarball did not contain packages/hub/dist/bin.js.`);
    console.error(`If you ran without ${CYAN}--beta${YELLOW}, the latest stable release likely predates the hub package.`);
    console.error(`Re-run with ${CYAN}--beta${YELLOW} to pull the latest pre-release, or with ${CYAN}--rebuild${YELLOW} to force a fresh source build.${RESET}\n`);
    process.exit(1);
  }

  ensureHubDeps(baseDir);

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

  // Default to a per-user data dir when the operator hasn't supplied one. The
  // hub's own default is /var/lib/agenfk-hub which only works when running as
  // root; non-root launches via npx should land somewhere writable instead.
  const env = { ...process.env };
  if (!env.AGENFK_HUB_DB_PATH) {
    env.AGENFK_HUB_DB_PATH = path.join(os.homedir(), '.agenfk-hub', 'hub.sqlite');
    console.log(`${BLUE}  Using default DB path: ${env.AGENFK_HUB_DB_PATH}${RESET}`);
    console.log(`${BLUE}  (override with AGENFK_HUB_DB_PATH=/your/path/hub.sqlite)${RESET}`);
  }

  console.log(`\n${GREEN}Starting AgEnFK Hub on port ${port}...${RESET}`);
  console.log(`${CYAN}  Open http://localhost:${port}/ in your browser${RESET}\n`);

  const child = spawn(process.execPath, [binPath], {
    stdio: 'inherit',
    env,
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
    await ensureDistribution({ installDir, repo: REPO, beta: isBeta });
  }

  startHub(installDir);
}

async function ensureDistribution({ installDir, repo, beta }) {
  console.log(`${GREEN}Downloading pre-built hub binary from GitHub...${RESET}`);
  try {
    const tag = await fetchLatestTagAsync(repo, beta);
    await downloadAsset(repo, tag, 'agenfk-dist.tar.gz', path.join(installDir, 'agenfk-dist.tar.gz'));
    execSync(`tar ${tarFlags} "${toPosixPath(path.join(installDir, 'agenfk-dist.tar.gz'))}" -C "${toPosixPath(installDir)}"`, { stdio: 'inherit' });
    fs.unlinkSync(path.join(installDir, 'agenfk-dist.tar.gz'));
    if (!fs.existsSync(path.join(installDir, 'packages/hub/dist/bin.js'))) {
      throw new Error(
        `Release tarball did not contain packages/hub/dist/bin.js — ` +
        `the resolved release likely predates the hub package. Re-run with --beta.`,
      );
    }
    return;
  } catch (e) {
    console.error(`${YELLOW}Failed to download pre-built binary: ${e.message}${RESET}`);
    console.log(`${BLUE}Falling back to source build...${RESET}`);
  }

  // Stale-install recovery: an existing install dir from an older beta may be
  // missing newer workspace directories (e.g. packages/flow-editor added in
  // beta.18). Overlay them from the REPO_ROOT (the npx-cached package) so
  // workspace resolution can succeed before we run npm install.
  overlayMissingWorkspaces(REPO_ROOT, installDir);

  console.log(`${GREEN}Installing build toolchain (devDependencies)...${RESET}`);
  execSync('npm install --include=dev --no-audit --no-fund --no-package-lock', { cwd: installDir, stdio: 'inherit' });
  execSync('npm run build -w packages/core -w packages/storage-sqlite -w packages/hub', { cwd: installDir, stdio: 'inherit' });
}

// Walk the REPO_ROOT package.json's workspaces array and copy any workspace
// directory that isn't yet present in the install dir. Idempotent — never
// overwrites an existing workspace dir, so users keep any local edits.
function overlayMissingWorkspaces(srcRoot, dstRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
    for (const ws of workspaces) {
      const srcDir = path.join(srcRoot, ws);
      const dstDir = path.join(dstRoot, ws);
      if (!fs.existsSync(srcDir)) continue;
      if (fs.existsSync(dstDir)) continue;
      console.log(`${BLUE}[hub] Overlaying missing workspace: ${ws}${RESET}`);
      if (fs.cpSync) {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } else {
        execSync(`cp -r ${JSON.stringify(srcDir)} ${JSON.stringify(path.dirname(dstDir))}/`, { stdio: 'inherit', shell: true });
      }
    }
  } catch (e) {
    console.warn(`${YELLOW}[hub] overlayMissingWorkspaces skipped: ${e.message}${RESET}`);
  }
}
