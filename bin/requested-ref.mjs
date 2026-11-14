// Which git ref the user asked npx for (#216).
//
// `npx github:cglab-public/agenfk#v2.0.0-beta.35` installs the package into
// <npx cache>/node_modules/agenfk and records the spec it was given in
// <npx cache>/package.json (`_npx.packages`, and `dependencies`). The
// bootstrap used to ignore it and extract the newest release's dist over the
// pinned source, so a pinned install was a mix of two releases.

// This repository and nothing else: `cglab-public/agenfk-tools` must not
// match. The spellings are the ones npm records for a GitHub spec.
const THIS_REPO = /^(?:github:|git\+https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)?cglab-public\/agenfk(?:\.git)?(?:#(.*))?$/i;

// A release tag is plain semver behind a `v`. Everything this returns ends up
// in a download URL run through a shell, so nothing outside this syntax may
// come out of here, whatever the manifest holds.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The ref after `#` in the spec npx was run with for this repository, or null
 * when it was run unpinned (or this is not an npx cache install).
 * @param {string} repoRoot the package root (<cache>/node_modules/agenfk)
 */
export function requestedGitRef(repoRoot, fsMod, pathMod) {
  // Only a real npx layout: anything else two levels up is not ours to read.
  if (pathMod.basename(pathMod.dirname(repoRoot)) !== 'node_modules') return null;
  let manifest;
  try {
    manifest = JSON.parse(fsMod.readFileSync(pathMod.resolve(repoRoot, '..', '..', 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const specs = [...(Array.isArray(manifest?._npx?.packages) ? manifest._npx.packages : []), manifest?.dependencies?.agenfk];
  for (const spec of specs) {
    if (typeof spec !== 'string') continue;
    const m = spec.trim().match(THIS_REPO);
    if (m) return m[1]?.trim() || null;
  }
  return null;
}

/** `v<version>` when `version` is plain semver, else null. */
export function releaseTagForVersion(version) {
  return typeof version === 'string' && VERSION.test(version) ? `v${version}` : null;
}

/**
 * The release whose dist belongs with a pinned ref: the tag itself when the
 * ref is a release tag, else (a branch - even one named like v2-maintenance -
 * a commit, a semver range) the release of the version that source declares.
 * Null when neither is plain release syntax.
 */
export function releaseTagForRef(ref, sourceVersion) {
  const tag = String(ref).replace(/\/+$/, '');
  if (tag.startsWith('v') && VERSION.test(tag.slice(1))) return tag;
  return releaseTagForVersion(sourceVersion);
}
