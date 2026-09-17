/**
 * Sync a source tree (the npx cache, or a clone) into the framework install dir
 * (~/.agenfk-system), pruning files the new version no longer ships.
 *
 * Why this exists: the update used to be a bare
 * `fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true })` — a MERGE. Anything
 * deleted upstream survived in the install dir forever, and scripts/install.mjs
 * copies every markdown out of `<rootDir>/commands` and `<rootDir>/skills` into
 * each client's global config, so a deleted file was faithfully re-installed on
 * every upgrade. That is how the repo-private /agenfk-release command, moved to
 * .claude/commands/ in July, was still landing in ~/.claude/commands/ in
 * September and leaking into unrelated user projects.
 *
 * Pruning is deliberately scoped, never a blanket mirror: the pre-built dist
 * bundle under each package arrives from the release tarball AFTER this sync and
 * is absent from the source tree, so mirroring the whole root would delete the
 * install it just built.
 *
 * Dependency-light on purpose: this runs from the npx bootstrap before anything
 * is built, so it may only use node builtins.
 */
import fs from 'fs';
import path from 'path';

/**
 * The source dirs whose CONTENTS scripts/install.mjs copies out into each
 * client's global config — where a file deleted upstream becomes a stale command
 * or skill in the user's sessions.
 *
 * install.mjs also copies bin/ and scripts/ files out (into ~/.agenfk/bin,
 * ~/.local/bin, ~/.config/opencode/plugins, ~/.pi/agent/extensions), but it does
 * so by explicit FILENAME, never by enumerating the directory — so a file
 * deleted upstream cannot leak from there. packages/ holds the downloaded dist.
 * All three are excluded on purpose; do not add them.
 *
 * Keep in step with the `rootDir, '<dir>'` reads there — a dir missing from this
 * list keeps leaking files deleted upstream.
 */
export const PRUNED_DIRS = [
  'clauderules',
  'codexrules',
  'commands',
  'cursorrules',
  'geminirules',
  'skills',
];

/**
 * Is `dir` on a case-insensitive volume? macOS and NTFS are, by default.
 *
 * It matters because fs.cpSync writing `agenfk.md` over an existing `AgenFK.md`
 * updates that entry IN PLACE and keeps the old spelling. Comparing exact-case
 * paths then reads the surviving file as "not shipped" and deletes it outright —
 * strictly worse than the unpruned copy this module replaces.
 */
export function isCaseInsensitive(dir) {
  const base = `.agenfk-case-probe-${process.pid}`;
  const lower = path.join(dir, base);
  try {
    fs.writeFileSync(lower, '');
    return fs.existsSync(path.join(dir, base.toUpperCase()));
  } catch {
    // Can't probe (read-only dir, EACCES, ENOSPC). Assume case-INSENSITIVE: that
    // folds more paths together and so deletes strictly less. Exact matching is
    // the over-deleting mode — it is the regression this function exists to stop.
    return true;
  } finally {
    try { fs.rmSync(lower, { force: true }); } catch { /* ignore */ }
  }
}

/** Paths (relative to the dir being walked) present in `root`.
 *
 * `strict` throws when a dir cannot be read. Use it for the SOURCE listing:
 * reading a PARTIAL source listing as "these files are not shipped" deletes live
 * files, so the caller must skip the dir instead. The DESTINATION walk stays
 * lenient — a partial listing there only means fewer files are considered, i.e.
 * under-pruning, and throwing would abort a user's upgrade over an unreadable
 * subdirectory. */
function listFiles(root, base = '', strict = false) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
  } catch (e) {
    if (strict) throw e;
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, rel, strict));
    else out.push(rel);
  }
  return out;
}

/**
 * Delete anything under PRUNED_DIRS that `sourceRoot` no longer provides.
 *
 * Pruning is kept strictly separate from copying: the callers copy by their own
 * means (fs.cpSync, `cp -r`, or `tar -xzf`) and prune afterwards. A prune that
 * reached for fs.cpSync would throw on the very runtimes the `cp -r` fallback
 * exists for.
 *
 * @param {string} sourceRoot
 * @param {string} installDir
 * @returns {{ removed: string[], failed: {path: string, reason: string}[] }}
 *   paths removed and paths it could not remove, relative to installDir
 */
export function pruneInstallDir(sourceRoot, installDir, opts = {}) {
  const shipped = new Map();
  const unreadable = new Set();
  for (const d of PRUNED_DIRS) {
    try {
      shipped.set(d, new Set(listFiles(path.join(sourceRoot, d), '', true)));
    } catch {
      // Unreadable source subtree: its contents are UNKNOWN, not empty. Skip
      // pruning the dir rather than read the partial listing as "not shipped".
      unreadable.add(d);
    }
  }
  // A dir that exists but is EMPTY is a broken source (interrupted cp -r, a
  // filtered copy, an aborted fetch), never a statement that everything in the
  // install dir is stale. existsSync alone was not enough.
  return pruneAgainst(
    installDir,
    (dir) => shipped.get(dir),
    (dir) => !unreadable.has(dir) && (shipped.get(dir)?.size ?? 0) > 0,
    opts,
  );
}

/**
 * Prune against an explicit manifest of the paths this version ships, rather
 * than against a second tree.
 *
 * The tar-based upgrade routes (`agenfk upgrade`, packages/create, the hub fleet
 * sync) extract agenfk-dist.tar.gz straight over the install dir, leaving no
 * second tree to diff — and reading "what we ship" back out of the install dir
 * is circular, because the install dir is the stale thing. `tar -tzf` is the
 * only authority there.
 *
 * @param {string} installDir
 * @param {Iterable<string>} shippedPaths archive paths, e.g. "commands/agenfk.md"
 * @returns {{ removed: string[], failed: {path: string, reason: string}[] }}
 */
export function pruneInstallDirAgainstManifest(installDir, shippedPaths, opts = {}) {
  const byDir = new Map(PRUNED_DIRS.map((d) => [d, new Set()]));
  for (const raw of shippedPaths) {
    // .trim() FIRST. A tar listing read on Windows (or from a CRLF pipe) carries
    // a trailing \r, and a bucket full of "commands/agenfk.md\r" is non-empty —
    // so the empty-source guard passes and every REAL file is judged unshipped.
    // Measured: two \r-suffixed entries deleted both real commands and left the
    // directory empty. Normalised here rather than at the three call sites, so
    // a future caller cannot reintroduce it.
    const norm = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const slash = norm.indexOf('/');
    if (slash < 0) continue;
    const top = norm.slice(0, slash);
    const rest = norm.slice(slash + 1);
    if (!rest || rest.endsWith('/')) continue;      // directory entry
    const bucket = byDir.get(top);
    if (bucket) bucket.add(rest.split('/').join(path.sep));
  }
  // A manifest listing none of a dir's files means the archive does not carry
  // that dir — never treat that as "everything here is stale".
  return pruneAgainst(installDir, (dir) => byDir.get(dir), (dir) => byDir.get(dir).size > 0, opts);
}

/**
 * @param {{ foldCase?: boolean }} [opts] force the case-folding decision instead
 *   of probing the volume. Only a test should pass this: the guard is otherwise
 *   unobservable on a case-sensitive filesystem (where folding is a no-op), so
 *   CI could not tell it from its own absence.
 */
function pruneAgainst(installDir, shippedFor, sourceHasDir, opts = {}) {
  const removed = [];
  const failed = [];
  for (const dir of PRUNED_DIRS) {
    const dstDir = path.join(installDir, dir);
    // A source that does not ship this dir prunes nothing: a truncated or
    // partial download must not strip the user's install.
    if (!sourceHasDir(dir) || !fs.existsSync(dstDir)) continue;

    // Never prune through a symlink. readdirSync FOLLOWS one, so a symlinked
    // commands/ or skills/ — something a framework developer plausibly points at
    // their own checkout — would have its TARGET deleted, outside the install
    // dir entirely. (Nested symlinks are already safe: Dirent.isDirectory() is
    // false for them, so listFiles never descends and rmSync drops only the link.)
    let dstReal;
    try {
      if (fs.lstatSync(dstDir).isSymbolicLink()) {
        failed.push({ path: dir, reason: 'symlinked; refusing to prune through it' });
        continue;
      }
      dstReal = fs.realpathSync(dstDir);
    } catch {
      continue;
    }

    const foldCase = opts.foldCase ?? isCaseInsensitive(dstDir);
    const fold = foldCase ? (p) => p.toLowerCase() : (p) => p;
    const shipped = new Set([...shippedFor(dir)].map(fold));
    const removedHere = [];
    for (const rel of listFiles(dstDir)) {
      if (shipped.has(fold(rel))) continue;
      const target = path.join(dstDir, rel);
      // Belt and braces: whatever the walk produced must still resolve inside
      // the directory we are pruning.
      try {
        const parent = fs.realpathSync(path.dirname(target));
        if (parent !== dstReal && !parent.startsWith(dstReal + path.sep)) {
          failed.push({ path: path.join(dir, rel), reason: 'resolves outside the install dir' });
          continue;
        }
      } catch {
        continue;
      }
      try {
        fs.rmSync(target, { force: true });
        removed.push(path.join(dir, rel));
        removedHere.push(rel);
      } catch (e) {
        // Best-effort must not be silent: an EPERM/EBUSY prune that vanishes
        // leaves the upgrade reporting clean while the leak persists.
        failed.push({ path: path.join(dir, rel), reason: e?.message || String(e) });
      }
    }
    // Only tidy directories this pass actually emptied files out of. Calling
    // this unconditionally also deleted directories the archive ships
    // intentionally empty (the manifest parser drops directory entries, so they
    // have no shipped children to keep them).
    if (removedHere.length > 0) pruneEmptyDirs(dstDir, removedHere);
  }
  return { removed, failed };
}

/**
 * Drop directories left empty by this pass, so stale skill dirs don't linger.
 *
 * Walks only the ANCESTORS of files just removed (`removedRels`), never the whole
 * subtree — a directory the archive ships intentionally empty must survive, and
 * it is indistinguishable from a newly-emptied one by `readdir().length === 0`.
 * Deepest first, so a parent is only tested after its emptied children are gone.
 */
function pruneEmptyDirs(root, removedRels) {
  const ancestors = new Set();
  for (const rel of removedRels) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && dir !== path.sep) {
      ancestors.add(dir);
      dir = path.dirname(dir);
    }
  }
  const deepestFirst = [...ancestors].sort((a, b) => b.length - a.length);
  for (const rel of deepestFirst) {
    const full = path.join(root, rel);
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch { /* ignore */ }
  }
}
