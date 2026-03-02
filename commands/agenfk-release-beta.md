---
description: Commit local changes, push to remote, and create a GitHub beta/pre-release
---

You are executing the `/agenfk-release-beta` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- **Cross-project guard**: If you generate or suggest a message that references a task ID (e.g. `[<uuid>]`), first call `get_item(<taskId>)` and verify its `projectId` matches `.agenfk/project.json`. If it does not match, omit the task reference and use a generic summary instead. Never embed a foreign task ID in a commit message.
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Push to remote**
Run `git push` and show the output to the user.

**Step 3 — GitHub Beta Release**
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next beta version.
- Ask for a tag name (e.g. `v1.2.0-beta.1`).
- **Sync Version**: Extract the numeric version from the tag (e.g. `1.2.0-beta.1` from `v1.2.0-beta.1`).
- Run `mkdir -p ~/.agenfk && touch ~/.agenfk/skip-gatekeeper` to allow file edits without a workflow task.
- For Node projects, update the `"version"` field in the root `package.json`, any `project.json` (if tracked), and ALL `packages/*/package.json` files to match this numeric version.
- Run `rm -f ~/.agenfk/skip-gatekeeper` to restore normal gatekeeper enforcement.
- Run `git add . && git commit -m "chore: bump version to <version>"` and show the output.
- Ask for a release title (default: same as tag).
- Offer to auto-generate release notes from git log: run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` and summarise the commits as bullet points.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists.
- **Push & Create Beta**: Run `git push origin HEAD` to ensure the version bump is on the remote branch, then run `gh release create <tag> agenfk-dist.tar.gz --prerelease --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.
