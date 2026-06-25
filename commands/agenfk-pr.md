---
description: Create a PR for the current item's branch and manage the PR lifecycle
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-pr <itemId>` command. Follow these steps precisely:

**Step 1 — Verify branch and item state**
- Run `agenfk get <itemId> --json` to read the current item (MCP: `get_item`).
- Check `item.branchName`:
  - If no branch is linked, inform the user: "No branch is linked to this item. Create and link one with `agenfk branch create <itemId>` (optionally `--name <branch-name>`)."
  - If a branch exists, confirm you are on it (`git branch --show-current`). If not, run `git checkout <branchName>`.

**Step 1.5 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one from `git diff --stat`).
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Create the Pull Request**
- If the item already has a `prUrl`, skip creation — the PR already exists. Show the existing URL instead.
- Otherwise push the branch (`git push -u origin <branchName>`), then create + register the PR. **Two paths — about your model id first:** `<YOUR-ACTUAL-MODEL-ID>` and `<YOUR-HARNESS>` below are placeholders — **do NOT copy them, and do NOT copy any example model id** (e.g. never report `claude-opus-4-8` unless that is genuinely your model). Report **your own model**. If you cannot state your model id directly (some harnesses don't expose it to the agent), determine it from the harness configuration or current session log before reporting — never omit or guess it. **On pi.dev, prefer the model the AgEnFK extension already injected for you**: the native extension posts a steer message of the form `… pass model = "<provider/id>" and harness = "pi" …` with the live model from `ctx.getModel()` — copy that exact id. Only if no such reminder is present, fall back to reading `~/.pi/agent/settings.json` (`defaultModel`, e.g. `@cf/zai-org/glm-5.2`) or the active session log which records the model per turn.

  **Preferred — one step (`agenfk pr create`):** Run `agenfk pr create <itemId> --title "<item.title>" --body "<summary>" --model <YOUR-ACTUAL-MODEL-ID> --harness <YOUR-HARNESS>`. This opens the PR via `gh`, stores the URL/number on the item, and **auto-registers the PR sizing** (derived from the item tree) so the `pr.opened` hub event fires with your model + harness — no separate `pr-register` call needed. `--model` and `--harness` are **required**.

  **Manual alternative (`gh` + `pr-register`):** If you ran `gh pr create` yourself, capture the PR URL/number, then register explicitly: `agenfk pr-register --item <itemId> --number <number> --repo <owner/repo> --epic <n> --story <n> --task <n> --bug <n> --model <YOUR-ACTUAL-MODEL-ID> --harness <YOUR-HARNESS>` (MCP: `register_pr`). **All flags are required**, and they're recorded on the `pr.opened` hub event.

**Step 3 — Confirm and wait**
- Show the user the PR URL and instruct them:
  > "Your PR is open. Once it has been reviewed and merged, run `/agenfk-release` to create a release."
- Do NOT poll or wait. The user will trigger the next step manually.

**Step 4 — (Optional) Check PR status**
If the user asks whether the PR is ready:
- Re-read the item with `agenfk get <itemId> --json` (MCP: `get_item`) and check `prStatus`.
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
