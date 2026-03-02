---
description: Create a PR for the current item's branch and manage the PR lifecycle
---

You are executing the `/agenfk-pr <itemId>` command. Follow these steps precisely:

**Step 1 — Verify branch and item state**
- Call `get_item(itemId)` to read the current item.
- Check `item.branchName`:
  - If no branch is linked, call `create_branch(itemId)` to create and switch to a feature branch.
  - If a branch exists, confirm you are on it.

**Step 1.5 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one from `git diff --stat`).
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Create the Pull Request**
- Call `create_pr(itemId, "<summary of changes>")` — this pushes the branch to the remote and opens a GitHub PR in one step.
- The tool stores `prUrl`, `prNumber`, and `prStatus` on the item automatically.
- If the item already has a `prUrl`, skip creation — the PR already exists. Show the existing URL instead.

**Step 3 — Confirm and wait**
- Show the user the PR URL and instruct them:
  > "Your PR is open. Once it has been reviewed and merged, run `/agenfk-release` to create a release."
- Do NOT poll or wait. The user will trigger the next step manually.

**Step 4 — (Optional) Check PR status**
If the user asks whether the PR is ready:
- Re-read the item with `get_item(itemId)` and check `prStatus`.
- Alternatively, run `gh pr view <prNumber> --json state` for a live check.
- If merged → tell the user to run `/agenfk-release`.
- If still open or in draft → tell the user to wait for approval.
- If closed without merge → warn the user and ask how they want to proceed.

---

**Key rules:**
- Always use MCP tools (`get_item`, `create_branch`, `create_pr`) as the primary path.
- Never poll in a loop. One check per user request.
- `/agenfk-release` will automatically gate on merged PR status — the user does not need to do anything special before running it.
- If `gh` CLI is not installed, `create_pr` will fail gracefully — inform the user and skip PR creation.
