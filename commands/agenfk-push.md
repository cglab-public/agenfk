---
description: Push current branch to remote and optionally create a GitHub release
---

You are executing the `/agenfk-push` command. Follow these steps precisely:

**Step 1 — Push to remote**
Run `git push` and show the output to the user.

**Step 2 — GitHub Release (optional)**
Ask the user: "Do you want to create a GitHub release?"

If YES:
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next version.
- Ask for a tag name (e.g. `v1.2.0`).
- Ask for a release title (default: same as tag).
- Offer to auto-generate release notes from git log: run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` and summarise the commits as bullet points.
- Confirm the notes with the user, allow edits.
- Run: `gh release create <tag> --title "<title>" --notes "<notes>"`
- Show the release URL returned by `gh`.

If NO:
- Confirm the push succeeded and stop.
