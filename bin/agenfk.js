#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { compareSemver, newestChannelTag } from './version-utils.mjs';
import { pruneInstallDir, pruneInstallDirAgainstManifest } from './sync-install-dir.mjs';
import { copyTree } from './copy-tree.mjs';
import { forceLocalFlag, tarPath } from './tar-flags.mjs';
import { requestedGitRef, releaseTagForRef, releaseTagForVersion } from './requested-ref.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(os.homedir(), '.agenfk-system');

const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const BLUE   = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

// Determine whether we're running from the npx cache or a real clone.
// A real clone has a .git directory; the npx cache does not.
const isNpxCache = !fs.existsSync(path.join(REPO_ROOT, '.git'));
const shouldRebuild = process.argv.includes('--rebuild');
const isBeta = process.argv.includes('--beta');
// install.mjs is quiet by default; --debuglog brings back its step-by-step log.
const debuglog = process.argv.includes('--debuglog');
// MCP is opt-in (CLI-only by default): forward --with-mcp / --no-mcp to install.mjs.
const withMcp = process.argv.includes('--with-mcp');
const noMcp = process.argv.includes('--no-mcp');

// SAFETY GUARD: this is the npx *installer bootstrap*, not the CLI dispatcher.
// Run against a git checkout it installs in place, and scripts/install.mjs's
// cleanStaleSrc step would DELETE packages/*/src. Refuse on ANY git working tree
// (a `.git` dir — the same signal `isNpxCache` keys off; the npx cache has none)
// unless explicitly forced. `hasSrc` only sharpens the warning.
const hasGit = fs.existsSync(path.join(REPO_ROOT, '.git'));
const hasSrc = fs.existsSync(path.join(REPO_ROOT, 'packages', 'cli', 'src'));
const forceInstall = process.argv.includes('--force-install');
if (hasGit && !forceInstall) {
  console.error(`${YELLOW}❌ Refusing to run the AgEnFK installer bootstrap from a source checkout.${RESET}`);
  console.error(`   This entry point (bin/agenfk.js) installs in place${hasSrc ? ` and would DELETE your\n   ${REPO_ROOT}/packages/*/src directories (via install.mjs cleanStaleSrc)` : ''}.\n`);
  console.error(`   If you meant to run a CLI command, use the dispatcher: ${CYAN}agenfk <command>${RESET}`);
  console.error(`   If you really want to (re)install from this clone: ${CYAN}npm run install:framework${RESET}`);
  console.error(`   To override this guard anyway: ${CYAN}node bin/agenfk.js --force-install${RESET}\n`);
  process.exit(1);
}

// On Windows, GNU tar (Git Bash's) treats "C:" as a remote hostname; --force-local
// disables that. The bsdtar Windows ships needs no such flag and rejects it, so
// it is passed only to GNU tar (GitHub #208, see tar-flags.mjs). Every path a tar
// command gets goes through tarPath() for the same reason: GNU tar on Windows
// unescapes backslashes, so it gets C:/... from any shell; bsdtar the native path.
// Refuse macOS metadata on the way IN. This is the path that actually polluted
// users: every published release up to v1.1.16-beta.4 was ~half AppleDouble
// (`._*`) entries, and this extraction lands the tarball straight into the
// install dir — after the filtered copyTree above, so that filter never sees it.
// Excluding here makes the outcome independent of any later sweep.
// (CGLAB-94 / issue #163)
// Double quotes, not single: cmd.exe keeps single quotes as part of the word, so
// on Windows the pattern was `'._*'` and excluded nothing. sh treats both alike.
const tarExcludes = '--exclude="._*" --exclude=".DS_Store"';
const tarFlags = process.platform === 'win32'
  ? `${forceLocalFlag()}${tarExcludes} -xzf`
  : `${tarExcludes} -xzf`;

// compareSemver gates the redownload-on-update downgrade guard. It is imported
// from ./version-utils.mjs (top of file) so prerelease ordering is correct
// (numeric identifiers compared numerically: 1.1.0-beta.10 > 1.1.0-beta.8). The
// previous inline copy compared prerelease strings lexically and pinned
// `npx … --beta` to beta.8.

// Read the local install's version. Returns null if the file is missing or unreadable.
function readLocalVersion(installDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : null;
  } catch { return null; }
}

// The release a channel installs - curl (no auth) first, gh CLI as fallback.
// BUG 4bd98e16: both used to pick by DATE with no hub-tag filter (`--beta` the
// newest release of any kind, its gh fallback `--limit 1` of any kind), so a hub
// image release or a hotfix on an older line could be installed as the
// framework. Now the CLI's rule (newestChannelTag): never hub-v*, the channel's
// newest by version. GitHub's /releases/latest (and `gh release view`) is
// date-chosen, so for stable it is only one candidate beside the list.
function fetchLatestTag(repo, beta = false) {
  // Same order as the CLI's: GitHub's own answer first, the list best-effort,
  // so a list that fails (rate limit, a page past maxBuffer) never throws away
  // a good /releases/latest. maxBuffer: the 100-release list is ~0.6 MB today
  // and grows with every release's notes; execSync's default is 1 MB.
  const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const curlJson = (url) => JSON.parse(run(`curl -fsSL "${url}" -H "Accept: application/vnd.github+json" -H "User-Agent: agenfk-installer"`));
  // --beta INCLUDES stable: once 2.0.0 ships, 2.0.0-beta.23 is not the newest
  // thing a beta user should get (the CLI's resolveReleaseTag does the same).
  const pick = (refs) => {
    const stable = newestChannelTag(refs, false);
    if (!beta) return stable;
    const pre = newestChannelTag(refs, true);
    if (pre && stable) return compareSemver(stable, pre) > 0 ? stable : pre;
    return pre || stable;
  };

  // Each source says whether its LIST answered: for --beta, GitHub's latest
  // alone is only ever a stable, so it is not an answer while the other source
  // could still list the newer beta.
  const viaApi = () => {
    const refs = [];
    let listed = false;
    try {
      const latest = curlJson(`https://api.github.com/repos/${repo}/releases/latest`)?.tag_name;
      if (latest) refs.push({ tag: latest, prerelease: false, publishedAt: 0 });
    } catch { /* the list alone decides */ }
    try {
      const list = curlJson(`https://api.github.com/repos/${repo}/releases?per_page=100`);
      for (const r of Array.isArray(list) ? list : []) {
        refs.push({ tag: r?.tag_name, prerelease: !!r?.prerelease, publishedAt: Date.parse(r?.published_at) || 0 });
      }
      listed = Array.isArray(list);
    } catch { /* latest alone decides */ }
    return { tag: pick(refs), listed };
  };
  const viaGh = () => {
    const refs = [];
    let listed = false;
    try {
      const viewed = run(`gh release view --repo ${repo} --json tagName --template '{{.tagName}}'`).trim();
      if (viewed) refs.push({ tag: viewed, prerelease: false, publishedAt: 0 });
    } catch { /* the list alone decides */ }
    try {
      const rows = JSON.parse(run(`gh release list --repo ${repo} --limit 100 --exclude-drafts --json tagName,isPrerelease,createdAt`) || '[]');
      for (const r of rows) refs.push({ tag: r?.tagName, prerelease: !!r?.isPrerelease, publishedAt: Date.parse(r?.createdAt) || 0 });
      listed = Array.isArray(rows);
    } catch { /* the viewed tag alone decides */ }
    return { tag: pick(refs), listed };
  };

  const api = viaApi();
  if (api.tag && (api.listed || !beta)) return api.tag;
  const gh = viaGh();
  if (gh.tag && (gh.listed || !beta)) return gh.tag;
  // Neither listed: a stable from either latest is the best that is known.
  const tag = api.tag || gh.tag;
  if (!tag) {
    throw new Error(`Could not resolve a ${beta ? 'pre-release or stable' : 'stable'} framework release for ${repo}: `
      + 'the GitHub API and gh both failed, or the repo lists only hub releases.');
  }
  return tag;
}

// Run the setup script, surfacing a clean failure instead of letting the success
// summary print on a partial/failed install (issue #86 #3). execSync throws on a
// non-zero exit; we translate that into an explicit error + non-zero exit code.
function runInstaller(cwd) {
  try {
    execSync(`node scripts/install.mjs${shouldRebuild ? ' --rebuild' : ''}${isBeta ? ' --beta' : ''}${withMcp ? ' --with-mcp' : ''}${noMcp ? ' --no-mcp' : ''}${debuglog ? ' --debuglog' : ''}`, { cwd, stdio: 'inherit', windowsHide: true });
  } catch {
    console.error(`\n${YELLOW}❌ AgEnFK installation failed — the setup step did not complete.${RESET}`);
    console.error(`${YELLOW}   Re-run with --debuglog to see every step:${RESET}`);
    console.error(`${YELLOW}     npx -p github:cglab-public/agenfk agenfk --debuglog${RESET}\n`);
    process.exit(1);
  }
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


// Never copy macOS AppleDouble / Finder metadata into the install dir. Releases
// packaged on macOS carried a `._<name>` twin for every file with an extended
// attribute; copied verbatim, they reached the skills sync and were surfaced as
// garbage skills in every agent session (CGLAB-94 / issue #163).
const isMacMetadata = (name) => name.startsWith('._') || name === '.DS_Store';
const copyFilter = (src) => !isMacMetadata(path.basename(src));
// Say what could not be pruned — an upgrade that reports clean while the leak
// persists is the failure mode this whole fix exists for. What WAS pruned is
// routine, and no longer listed file by file (e04dac92).
function reportPrune({ removed, failed }) {
  for (const f of failed) console.log(`${YELLOW}  Could not prune ${f.path}: ${f.reason}${RESET}`);
}

if (isNpxCache) {
  const isUpdate = fs.existsSync(INSTALL_DIR);
  // Read the INSTALLED version BEFORE the overlay below replaces package.json
  // with REPO_ROOT's. Both downgrade guards compare against "what is installed",
  // and reading it AFTER the copy compared the npx ref with itself — so the
  // guard could not see a beta install newer than main, which is the one case
  // it exists for.
  const installedVersion = readLocalVersion(INSTALL_DIR);
  // Set when the release archive pruned the install dir, so the source-tree
  // fallback below does not prune a second time against a different ref.
  let prunedAgainstArchive = false;
  // Set whenever the install dir is NOT on a ref we may prune it against, so
  // the source-tree fallback must not run. (Named for the question it answers,
  // not for one of the reasons: "kept newer install" misdescribed the
  // download-failure case, which is how that path was missed.)
  let skipSourcePrune = false;

  // #216: a pinned ref (`npx github:cglab-public/agenfk#<tag>`) gets ITS
  // release's dist, fetched BEFORE anything is copied: once the pinned source
  // is over the install dir, a failed download would leave it on another
  // release's dist - the mix this exists to prevent. So a pin that cannot be
  // fetched stops here, with the install untouched.
  const pinnedRef = shouldRebuild ? null : requestedGitRef(REPO_ROOT, fs, path);
  let pinnedTag = null;
  let pinnedArchive = null;
  if (pinnedRef) {
    pinnedTag = releaseTagForRef(pinnedRef, readLocalVersion(REPO_ROOT));
    pinnedArchive = path.join(os.tmpdir(), `agenfk-dist-${process.pid}-${Date.now()}.tar.gz`);
    try {
      if (!pinnedTag) throw new Error('it is neither a release tag nor a tree that declares a release version');
      downloadAsset('cglab-public/agenfk', pinnedTag, 'agenfk-dist.tar.gz', pinnedArchive);
      // Read it through once, too: a truncated or corrupt archive must also
      // fail here, before the pinned source goes in, not at extraction.
      const listFlags = process.platform === 'win32' ? `${forceLocalFlag()}-tzf` : '-tzf';
      execSync(`tar ${listFlags} "${tarPath(pinnedArchive)}"`, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    } catch (e) {
      try { fs.unlinkSync(pinnedArchive); } catch { /* never written */ }
      console.error(`${YELLOW}❌ Could not fetch the release for the requested ref ${JSON.stringify(pinnedRef)}${pinnedTag ? ` (${pinnedTag})` : ''}: ${e.message}${RESET}`);
      console.error(`${YELLOW}   Nothing was changed${isUpdate ? ` in ${INSTALL_DIR}` : ''}. Pin a published release tag, or run without a ref to install the latest.${RESET}`);
      process.exit(1);
    }
  }

  if (isUpdate) {
    console.log(`${GREEN}Updating AgEnFK at ${INSTALL_DIR}...${RESET}`);
    // Copy the new files over the existing install AND prune what this version
    // no longer ships. A bare overlay left deleted files behind forever, and
    // install.mjs re-installed them into every client's global config — that is
    // how the repo-private /agenfk-release command kept coming back.
    copyTree(REPO_ROOT, INSTALL_DIR, { filter: copyFilter });
  } else {
    console.log(`${GREEN}Installing AgEnFK to ${INSTALL_DIR}...${RESET}`);
    copyTree(REPO_ROOT, INSTALL_DIR, { filter: copyFilter });
  }

  const distMissing = !fs.existsSync(path.join(INSTALL_DIR, 'packages/cli/dist')) || !fs.existsSync(path.join(INSTALL_DIR, 'packages/server/dist'));
  // Always download on update (to replace stale binaries); on fresh install only if dist missing
  if (!shouldRebuild && (isUpdate || distMissing)) {
    const REPO = 'cglab-public/agenfk';
    try {
      const latestTag = pinnedTag || fetchLatestTag(REPO, isBeta);
      // Downgrade guard: refuse to extract a tag whose version is older than
      // the existing install. Without this, `npx github:cglab-public/agenfk`
      // (no --beta) on a beta install resolves to the latest *stable* tag,
      // which is older than the local prerelease, and tar -xzf silently
      // reverts the install. (Bug 28635f38.)
      const localVersion = installedVersion;
      const remoteVersion = String(latestTag || '').replace(/^v/, '');
      // Not for a pin: the user named that version, and its source is already in.
      if (!pinnedTag && localVersion && remoteVersion && compareSemver(remoteVersion, localVersion) < 0) {
        console.log(`${YELLOW}Skip: refusing to downgrade — local install is on a newer version (${localVersion}) than the resolved tag (${remoteVersion}). Pass --beta to track prereleases.${RESET}`);
        // And skip the prune entirely. The install dir is deliberately left on a
        // NEWER ref than either the resolved tag or REPO_ROOT (the npx git ref,
        // i.e. the default branch). Pruning it against main would delete every
        // command the newer prerelease adds that main lacks — the same failure
        // the archive fork below exists to prevent, one branch over.
        skipSourcePrune = true;
      } else {
        const archive = path.join(INSTALL_DIR, 'agenfk-dist.tar.gz');
        try {
        if (pinnedArchive) {
          // Fetched up front (above); copy, not rename: tmp may be another volume.
          fs.copyFileSync(pinnedArchive, archive);
          fs.unlinkSync(pinnedArchive);
        } else {
          downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', archive);
        }
        execSync(`tar ${tarFlags} "${tarPath(archive)}" -C "${tarPath(INSTALL_DIR)}"`, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        // Prune against the ARCHIVE, not against REPO_ROOT. REPO_ROOT is the
        // npx git ref (the default branch); the tarball is fetchLatestTag,
        // which is a DIFFERENT ref — betas are cut from release/vX.Y.Z-beta.N
        // branches. Pruning a beta tarball against main deletes any command the
        // beta adds that main lacks, so the install ships without a command it
        // ships. The archive is the last writer here, so it is the authority.
        try {
          if (isUpdate) {
            const listFlags = process.platform === 'win32' ? `${forceLocalFlag()}-tzf` : '-tzf';
            const listing = execSync(`tar ${listFlags} "${tarPath(archive)}"`, { encoding: 'utf8', windowsHide: true })
              .split('\n').filter(Boolean);
            reportPrune(pruneInstallDirAgainstManifest(INSTALL_DIR, listing));
            prunedAgainstArchive = true;
          }
        } catch (e) {
          // The download and extract SUCCEEDED; only the listing failed. Letting
          // this reach the outer catch printed "Failed to download pre-built
          // binary" and "Falling back to source-based installation", both false,
          // and then pruned against main anyway.
          console.error(`${YELLOW}Could not prune against the release archive: ${e.message}${RESET}`);
          skipSourcePrune = true; // don't fall back to a different ref
        }
        } finally {
          // Covers the download and the extract too, not just the listing: curl
          // writes a partial .tar.gz before failing, and that used to sit in the
          // install dir permanently.
          try { fs.unlinkSync(archive); } catch { /* already gone */ }
        }
      }
    } catch (e) {
      if (pinnedTag) {
        // The archive was fetched and read before the copy, so this is rarer
        // (a full disk, say) - but the pinned source is already in, and the
        // fallback below would finish the install on another release's dist.
        console.error(`${YELLOW}❌ Could not install ${pinnedTag}'s pre-built binary: ${e.message}${RESET}`);
        console.error(`${YELLOW}   ${INSTALL_DIR} now holds ${pinnedTag}'s source without its binaries. Re-run the same command to finish.${RESET}`);
        process.exit(1);
      }
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
      // And do NOT prune. The existing install is on the tag the user already
      // has, which may be NEWER than REPO_ROOT (the npx git ref = the default
      // branch) — a prerelease, say. Unauthenticated api.github.com is rate
      // limited at 60/h, so fetchLatestTag throwing is routine, and pruning a
      // beta install against main would delete every command the beta adds.
      // Before this, that made a transient rate limit destructive where the
      // pre-change behaviour was a harmless no-op overlay.
      skipSourcePrune = true;
    }
  }

  // A pinned archive the block above did not consume (no download was due).
  if (pinnedArchive) { try { fs.unlinkSync(pinnedArchive); } catch { /* consumed */ } }

  // Only when the npx cache genuinely IS the last writer for PRUNED_DIRS —
  // i.e. --rebuild, where no archive was ever fetched. Every path where the
  // install dir might be on a different (or newer) ref sets skipSourcePrune.
  if (isUpdate && !prunedAgainstArchive && !skipSourcePrune) {
    // Same downgrade guard the archive path applies above, and for the same
    // reason: REPO_ROOT is the npx git ref (the default branch), while a beta
    // install sits on a newer prerelease. Deleting the files this ref lacks
    // would strip every command the newer tag ships — the failure the archive
    // fork exists to prevent. (--rebuild skips the download block entirely, so
    // it never reached that guard.)
    const sourceVersion = readLocalVersion(REPO_ROOT);
    if (installedVersion && sourceVersion && compareSemver(sourceVersion, installedVersion) < 0) {
      console.log(`${YELLOW}Skip: not pruning — the install is on a newer version (${installedVersion}) than this source tree (${sourceVersion}).${RESET}`);
    } else {
      reportPrune(pruneInstallDir(REPO_ROOT, INSTALL_DIR));
    }
  }

  runInstaller(INSTALL_DIR);
} else {
  // Running from a real git clone — install in place
  console.log(`${GREEN}Installing AgEnFK in place at ${REPO_ROOT}...${RESET}`);

  const distMissing = !fs.existsSync(path.join(REPO_ROOT, 'packages/cli/dist')) || !fs.existsSync(path.join(REPO_ROOT, 'packages/server/dist'));
  if (!shouldRebuild && distMissing) {
    const REPO = 'cglab-public/agenfk';
    try {
      // #216: this clone's own release, not whatever is newest - the dist must
      // match the source it lands in.
      const latestTag = releaseTagForVersion(readLocalVersion(REPO_ROOT)) || fetchLatestTag(REPO, isBeta);
      downloadAsset(REPO, latestTag, 'agenfk-dist.tar.gz', path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
      execSync(`tar ${tarFlags} "${tarPath(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'))}" -C "${tarPath(REPO_ROOT)}"`, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      fs.unlinkSync(path.join(REPO_ROOT, 'agenfk-dist.tar.gz'));
    } catch (e) {
      console.error(`Failed to download pre-built binary: ${e.message}`);
      console.log(`${BLUE}Falling back to source-based installation...${RESET}`);
    }
  }

  runInstaller(REPO_ROOT);
}

// install.mjs prints the closing summary (and the PATH hint, when one is needed).
