---
description: Cut a hub-only release — tag hub-v* so CI ships the hub Docker image + GitHub Release with the hub dist tarball
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-release-hub` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**What a hub-only release is**: a `hub-v*` git tag. Pushing it triggers `.github/workflows/hub-image.yml`, which (a) builds and pushes the hub Docker image to GHCR and (b) creates a GitHub Release for the tag carrying `agenfk-hub-dist.tar.gz` (packaged by `scripts/package-hub-dist.mjs`) for the non-Docker path. Global `v*` releases (`/agenfk-release`) still include the hub — use this command only when the hub must ship **between** framework releases.

**Step 1 — Branch check**
Run `git status` and `git branch --show-current`. Hub releases are cut from `main` with a clean tree. If the tree is dirty or you are not on `main`, stop and ask the user how to proceed (same options as `/agenfk-release` Step 1).

**Step 2 — Pick the hub version**
- Run `git tag --sort=-v:refname | grep '^hub-v' | head -5` and `git tag --sort=-v:refname | grep '^v' | head -5`, and read the current `packages/hub/package.json` version. Show all three to the user.
- Propose the next hub tag: take the **highest** version among the latest `v*` tag, the latest `hub-v*` tag, and `packages/hub/package.json`, and bump its patch (e.g. framework at `v1.1.7`, no newer hub tag → propose `hub-v1.1.8`). Ask the user to confirm or override.
- Namespacing note: `hub-v*` and `v*` tags never collide in git, GHCR image tags, or GitHub Releases — a later framework `v1.1.8` alongside `hub-v1.1.8` is harmless (that framework release supersedes the hub-only one by definition).

**Step 3 — Bump the hub version**
- Run `mkdir -p ~/.agenfk && touch ~/.agenfk/skip-gatekeeper` to allow file edits without a workflow task.
- Set `packages/hub/package.json` `version` to the chosen version (hub package only — do NOT touch the root or other packages; the global release flow owns those).
- Regenerate the lockfile: `npm install --package-lock-only` (skip if no lockfile).
- Run `rm -f ~/.agenfk/skip-gatekeeper` to restore normal gatekeeper enforcement.
- Run `git add packages/hub/package.json package-lock.json && git commit -m "chore(hub): bump hub version to <version>"` and show the output.

**Step 4 — Tag, push, release**
- Run `git tag hub-v<version>` on the bump commit, then `git push origin HEAD --tags`.
- CI does the rest (image + GitHub Release + tarball). Report the tag and the expected release URL (`https://github.com/<owner>/<repo>/releases/tag/hub-v<version>`) to the user and stop — do not sit polling the workflow.
