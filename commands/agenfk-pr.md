---
description: Create a PR for the current item's branch and manage the PR lifecycle
---

You are executing the `/agenfk-pr <itemId>` command. Follow these steps precisely:

**Step 1 — Verify branch and item state**
- Call `get_item(itemId)` to read the current item.
- Check `item.branchName`:
  - If no branch is linked, inform the user: "No branch is linked to this item. Please create a branch manually (`git checkout -b <branch-name>`) and link it to the item via `update_item({ id, branchName: '<branch-name>' })`."
  - If a branch exists, confirm you are on it (`git branch --show-current`). If not, run `git checkout <branchName>`.

**Step 1.5 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one from `git diff --stat`).
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Create the Pull Request**
- If the item already has a `prUrl`, skip creation — the PR already exists. Show the existing URL instead.
- Otherwise:
  1. Push the branch: `git push -u origin <branchName>`
  2. Create the PR via `gh pr create --title "<item.title>" --body "<summary>"` (adjust as needed).
  3. Capture the PR URL from the output.
  4. Store the result on the item: `update_item({ id: itemId, prUrl: "<url>", prNumber: <number>, prStatus: "open" })`.

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
- Branch and PR creation are the developer's responsibility. This command only guides the process.
- Never poll in a loop. One check per user request.
- `/agenfk-release` will proceed once on `main` — the user is responsible for merging before running it.
- If `gh` CLI is not installed, inform the user and skip PR creation.
