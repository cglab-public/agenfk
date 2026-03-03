---
description: Commit local changes, push to remote, and optionally create a GitHub release
---

You are executing the `/agenfk-release` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Branch check**
Run `git branch --show-current` to determine the current branch.

If **not on `main`**:
- Tell the user which branch they are on and that releases are created from `main`.
- Ask the user how they want to proceed, offering exactly these options:
  1. **Merge to main locally** — fetch origin, switch to `main`, pull latest, merge the feature branch (with `--no-edit`), then rebase if diverged. Continue to Step 2 on `main`.
  2. **Create a PR manually** — run `/agenfk-pr` or create the PR yourself via `gh pr create`. Then re-run `/agenfk-release` after the PR is merged.
  3. **Continue on this branch** — skip the merge and release from the current branch as-is (advanced, user takes responsibility).

If already on `main`, continue to Step 2.

**Step 2 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- **Cross-project guard**: If you generate or suggest a message that references a task ID (e.g. `[<uuid>]`), first call `get_item(<taskId>)` and verify its `projectId` matches `.agenfk/project.json`. If it does not match, omit the task reference and use a generic summary instead. Never embed a foreign task ID in a commit message.
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 3 — GitHub Release (optional)**
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
  - **STRICT SCOPE**: Only include changes that appear in the `git log` output above. Do NOT carry forward items from previous release notes, from other projects, or from your conversation context. Each release note must map 1-to-1 to a commit in the log range.
  - **Cross-project guard**: If a commit message contains a task ID in brackets (e.g. `[1a18154d-...]`), verify it belongs to the current project by checking `.agenfk/project.json`. If the project ID does not match, omit the task reference from the release note and note it as a possible mislabelled commit.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists.
- **Push & Create**: Run `git push origin HEAD` to ensure the version bump is on the remote branch, then run `gh release create <tag> agenfk-dist.tar.gz --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.

If NO:
- **Step 4 — Push to remote**
- Run `git push` and show the output to the user.
- Confirm the push succeeded and stop.
