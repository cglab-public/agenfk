---
description: Commit local changes, push to remote, and create a GitHub beta/pre-release
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-release-beta` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- **Cross-project guard**: If you generate or suggest a message that references a task ID (e.g. `[<uuid>]`), first run `agenfk get <taskId> --json` (MCP: `get_item`) and verify its `projectId` matches `.agenfk/project.json`. If it does not match, omit the task reference and use a generic summary instead. Never embed a foreign task ID in a commit message.
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 2 — Push to remote**
Run `git push` and show the output to the user.

**Step 3 — GitHub Beta Release**
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next beta version.
- Ask for a tag name (e.g. `v1.2.0-beta.1`).
- **Sync Version**: Extract the numeric version from the tag (e.g. `1.2.0-beta.1` from `v1.2.0-beta.1`).
- Run `mkdir -p ~/.agenfk && touch ~/.agenfk/skip-gatekeeper` to allow file edits without a workflow task.
- Update the version string in the project's manifest file(s). Adapt to the stack you're in:
  - **Node**: root `package.json`, any `project.json` (if tracked), and ALL `packages/*/package.json` files (don't forget `dependencies` + `devDependencies` + `peerDependencies` references to internal `@scope/*` workspace packages).
  - **Python**: `pyproject.toml` (`[project].version` or `[tool.poetry].version`), and any `__init__.py` `__version__` constant.
  - **Rust**: root `Cargo.toml` `[package].version` and every workspace member's `Cargo.toml`.
  - **.NET**: every `*.csproj` `<Version>` (or `Directory.Build.props` if centralised).
  - **Java/Kotlin**: `pom.xml` `<version>` or `gradle.properties` `version=`.
  - **Go**: module versions are tag-driven; usually no manifest edit needed.
- **Regenerate the lockfile** so it agrees with the manifest. Detect the lockfile in the repo root (or worktree root) and run the matching command. Stage the lockfile in the same `chore: bump version` commit so the manifest and lockfile never drift apart. If no lockfile is present in the tree, treat this step as a **no-op** — do not error.
  | Lockfile present | Command to run |
  |---|---|
  | `package-lock.json` | `npm install --package-lock-only` |
  | `pnpm-lock.yaml` | `pnpm install --lockfile-only` |
  | `yarn.lock` (Berry) | `yarn install --mode=update-lockfile` |
  | `yarn.lock` (Classic v1) | skip — Yarn 1 cannot regenerate without installing |
  | `poetry.lock` | `poetry lock --no-update` |
  | `uv.lock` | `uv lock` |
  | `Pipfile.lock` | `pipenv lock` |
  | `Cargo.lock` | `cargo update --workspace --offline` (or `cargo build` if offline mode is unavailable) |
  | `packages.lock.json` (.NET, with `RestorePackagesWithLockFile=true`) | `dotnet restore --force-evaluate` |
  | none of the above | no-op; skip and continue |
- Run `rm -f ~/.agenfk/skip-gatekeeper` to restore normal gatekeeper enforcement.
- Run `git add . && git commit -m "chore: bump version to <version>"` and show the output. The commit MUST include both the manifest change(s) AND the regenerated lockfile (when one exists).
- Ask for a release title (default: same as tag).
- Offer to auto-generate release notes from git log: run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` and summarise the commits as bullet points.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists.
- **Tag & Push**: Run `git tag <tag>` to create the tag locally on the version-bump commit, then run `git push origin HEAD --tags` to push both the commit and the tag to the remote.
- **Create Beta Release**: Run `gh release create <tag> agenfk-dist.tar.gz --prerelease --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.
