#!/usr/bin/env bash
# Attach build outputs to the GitHub release for a tag (CGLAB-621).
#
#   scripts/attach-release-assets.sh [--skip-existing] <tag> <file>...
#
# Used by both jobs of .github/workflows/desktop-release.yml, on every runner -
# Windows included, through Git Bash.
#
# The release is named after the `v<version>` tag. A legacy `desktop-v<version>`
# tag is accepted and its prefix stripped, so the installers land on the release
# people are already sent to instead of a second page. Anything that is not a
# version tag is refused: `gh release create` on a branch name would mint a new
# tag and a full release.
#
# THE RELEASE FLOW OWNS THE RELEASE. It pushes the tag, then creates the release
# with its notes and tarball - seconds later normally, minutes later if its
# operator is slow to approve a prompt. Creating the release here first would
# make the flow's `gh release create` fail with "already exists". So this waits
# for it (ATTACH_WAIT_SECONDS, default 15 minutes) and only then creates one
# itself - the case of a tag pushed with no release at all. A pre-release only
# when the version has a pre-release part, so a stable tag never becomes one.
#
# Three platform jobs can reach the create at once: losing that race to another
# job is success, not a failure.
#
# --skip-existing: leave a file the release already has alone instead of
# replacing it (the dist bundle the releaser built and checked locally).
set -euo pipefail

skip_existing=0
if [ "${1:-}" = "--skip-existing" ]; then
  skip_existing=1
  shift
fi

if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  echo "usage: $0 [--skip-existing] <tag> <file>..." >&2
  exit 2
fi

TAG="${1#desktop-}"
shift

if [[ ! "$TAG" =~ ^v[0-9] ]]; then
  echo "attach-release-assets: '$TAG' is not a version tag (v<version>)" >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "attach-release-assets: no files to attach to $TAG" >&2
  exit 1
fi

wait_seconds="${ATTACH_WAIT_SECONDS:-900}"
poll_seconds="${ATTACH_POLL_SECONDS:-30}"
# Bash's own clock, not a sum of the poll interval: a zero interval would never
# add up to the deadline.
deadline=$((SECONDS + wait_seconds))
until gh release view "$TAG" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "attach-release-assets: no release for $TAG after ${wait_seconds}s, creating it" >&2
    if [[ "$TAG" == *-* ]]; then
      flags=(--prerelease)
    else
      flags=()
    fi
    gh release create "$TAG" ${flags[@]+"${flags[@]}"} --title "$TAG" --notes "Release $TAG" \
      || gh release view "$TAG" >/dev/null
    break
  fi
  sleep "$poll_seconds"
done

files=("$@")
if [ "$skip_existing" -eq 1 ]; then
  existing="$(gh release view "$TAG" --json assets --jq '.assets[].name')"
  files=()
  for f in "$@"; do
    if grep -qxF "$(basename "$f")" <<<"$existing"; then
      echo "attach-release-assets: $TAG already has $(basename "$f"), keeping it" >&2
    else
      files+=("$f")
    fi
  done
  if [ "${#files[@]}" -eq 0 ]; then
    exit 0
  fi
fi

gh release upload "$TAG" "${files[@]}" --clobber
