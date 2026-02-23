---
description: Commit local changes, push to remote, and create a GitHub beta/pre-release
---

You are executing the `/agenfk-release-beta` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Push to remote**
Run `git push` and show the output to the user.

**Step 3 — GitHub Beta Release**
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next beta version.
- Ask for a tag name (e.g. `v1.2.0-beta.1`).
- **Sync Version**: Extract the numeric version from the tag (e.g. `1.2.0-beta.1` from `v1.2.0-beta.1`).
- For Node projects, update the `"version"` field in the root `package.json` and ALL `packages/*/package.json` files to match this numeric version.
- Run `git add . && git commit -m "chore: bump version to <version>"` and show the output.
- Ask for a release title (default: same as tag).
- Offer to auto-generate release notes from git log: run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` and summarise the commits as bullet points.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists.
- **Push & Create Beta**: Run `git push` then `gh release create <tag> agenfk-dist.tar.gz --prerelease --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.
