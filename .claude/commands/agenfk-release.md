---
description: Commit local changes, push to remote, and optionally create a GitHub release
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

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
- **Cross-project guard**: If you generate or suggest a message that references a task ID (e.g. `[<uuid>]`), first run `agenfk get <taskId> --json` (MCP: `get_item`) and verify its `projectId` matches `.agenfk/project.json`. If it does not match, omit the task reference and use a generic summary instead. Never embed a foreign task ID in a commit message.
- Run `git add . && git commit -m "<message>"` and show the output.

**Step 3 — GitHub Release (optional)**
Ask the user: "Do you want to create a GitHub release?"

If YES:
- Run `git tag --sort=-v:refname | head -5` and show the last tags so the user can pick the next version.
- Ask for a tag name (e.g. `v1.2.0`).
- **Sync Version**: Extract the numeric version from the tag (e.g. `1.2.0` from `v1.2.0`).
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
  - **STRICT SCOPE**: Only include changes that appear in the `git log` output above. Do NOT carry forward items from previous release notes, from other projects, or from your conversation context. Each release note must map 1-to-1 to a commit in the log range.
  - **Cross-project guard**: If a commit message contains a task ID in brackets (e.g. `[1a18154d-...]`), verify it belongs to the current project by checking `.agenfk/project.json`. If the project ID does not match, omit the task reference from the release note and note it as a possible mislabelled commit.
- Confirm the notes with the user, allow edits.
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists. Then verify it carries no macOS metadata — **do not use `tar -tzf`**, which on macOS silently merges AppleDouble entries into their parent and reports a clean archive (this is how CGLAB-94 shipped in every release from v1.1.13 to v1.1.16-beta.4):
  ```bash
  node -e "const{gunzipSync}=require('zlib'),{readFileSync}=require('fs');const b=gunzipSync(readFileSync('agenfk-dist.tar.gz'));let o=0,n=[];while(o+512<=b.length){const f=b.subarray(o,o+100),i=f.indexOf(0),m=f.subarray(0,i===-1?100:i).toString();if(!m){o+=512;continue}n.push(m);o+=512+Math.ceil((parseInt(b.subarray(o+124,o+136).toString('ascii').replace(/\0.*$/,'').trim(),8)||0)/512)*512}const bad=n.filter(x=>(x.replace(/\/$/,'').split('/').pop()||'').startsWith('._')||x.endsWith('.DS_Store'));console.log(bad.length?'DIRTY: '+bad.length+' macOS metadata entries':'CLEAN: '+n.length+' members');process.exit(bad.length?1:0)"
  ```
  Abort the release if it reports `DIRTY`.
- **Tag & Push**: Run `git tag <tag>` to create the tag locally on the version-bump commit, then run `git push origin HEAD --tags` to push both the commit and the tag to the remote.
- **Create Release**: Run `gh release create <tag> agenfk-dist.tar.gz --title "<title>" --notes "<notes">`.
- Show the release URL returned by `gh`.

If NO:
- **Step 4 — Push to remote**
- Run `git push` and show the output to the user.
- Confirm the push succeeded and stop.
