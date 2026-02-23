---
description: Commit local changes, push to remote, and optionally create a GitHub release
---

You are executing the `/agenfk-release` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — GitHub Release (optional)**
Ask the user: "Do you want to create a GitHub release?"

If YES:
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next version.
- Ask for a tag name (e.g. `v1.2.0`).
- **Sync Version**: Extract the numeric version from the tag (e.g. `1.2.0` from `v1.2.0`).
- Run `mkdir -p ~/.agenfk && touch ~/.agenfk/skip-gatekeeper` to allow file edits without a workflow task.
- For Node projects, update the `"version"` field in the root `package.json`, any `project.json` (if tracked), and ALL `packages/*/package.json` files to match this numeric version. Adapt this action to other stacks (pyproject.toml, csproj, etc)
- Run `rm -f ~/.agenfk/skip-gatekeeper` to restore normal gatekeeper enforcement.
- Run `git add . && git commit -m "chore: bump version to <version>"` and show the output.
- Ask for a release title (default: same as tag).
- Offer to auto-generate release notes from git log: run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` and summarise the commits as bullet points.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists.
- **Push & Create**: Run `git push origin HEAD` to ensure the version bump is on the remote branch, then run `gh release create <tag> agenfk-dist.tar.gz --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.

If NO:
- **Step 3 — Push to remote**
- Run `git push` and show the output to the user.
- Confirm the push succeeded and stop.
