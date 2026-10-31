---
description: Commit local changes, push to remote, and create a GitHub beta/pre-release
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-release-beta` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Commit local changes**
Check for local changes using `git status`. If there are unstaged or uncommitted changes:
- Ask the user for a commit message (or offer to generate one).
- **Cross-project guard**: If you generate or suggest a message that references a task ID (e.g. `[<uuid>]`), first run `agenfk get <taskId> --json` (MCP: `get_item`) and verify its `projectId` matches the id `agenfk current-project` prints. If it does not match, omit the task reference and use a generic summary instead. Never embed a foreign task ID in a commit message.
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
- **Package Distributable**: Run `node scripts/package-dist.mjs` and verify `agenfk-dist.tar.gz` exists. Then verify it carries no macOS metadata — **do not use `tar -tzf`**, which on macOS silently merges AppleDouble entries into their parent and reports a clean archive (this is how CGLAB-94 shipped in every release from v1.1.13 to v1.1.16-beta.4):
  ```bash
  node -e "const{gunzipSync}=require('zlib'),{readFileSync}=require('fs');const b=gunzipSync(readFileSync('agenfk-dist.tar.gz'));let o=0,n=[];while(o+512<=b.length){const f=b.subarray(o,o+100),i=f.indexOf(0),m=f.subarray(0,i===-1?100:i).toString();if(!m){o+=512;continue}n.push(m);o+=512+Math.ceil((parseInt(b.subarray(o+124,o+136).toString('ascii').replace(/\0.*$/,'').trim(),8)||0)/512)*512}const bad=n.filter(x=>(x.replace(/\/$/,'').split('/').pop()||'').startsWith('._')||x.endsWith('.DS_Store'));console.log(bad.length?'DIRTY: '+bad.length+' macOS metadata entries':'CLEAN: '+n.length+' members');process.exit(bad.length?1:0)"
  ```
  Abort the release if it reports `DIRTY`.
- **Suite gate (#249)**: Before tagging, run the full suite on the version-bump commit you are about to tag: `npm test`. Read BOTH vitest summary lines (`Test Files` and `Tests`): an import-time throw fails a file with 0 failed tests, so the `Tests` line alone can read green. The run must exit 0 (vitest exits non-zero on an unhandled error even when both lines read green) and neither line may report a failure. Otherwise **STOP**: do not tag, do not push, do not create the release; report the failing files to the user. Say in your final report that the gate ran and what it printed. CI is not a substitute here - the bump commit has no CI run until it is pushed.
- **Build the Airlock image first (CGLAB-696)**: every `agenfk airlock` launch of this version pulls `ghcr.io/<owner>/agenfk-airlock-base:<version>`, so it must exist before the release does. Push the version-bump commit alone (`git push origin HEAD`), then build the image from it and wait for it:
  ```bash
  SHA=$(git rev-parse HEAD); BRANCH=$(git branch --show-current)
  gh workflow run airlock-image.yml --ref "$BRANCH" -f version=<version>
  sleep 10   # the run takes a moment to be listed
  RUN=$(gh run list --workflow airlock-image.yml --branch "$BRANCH" --event workflow_dispatch --limit 5 --json databaseId,headSha --jq "map(select(.headSha == \"$SHA\"))[0].databaseId")
  gh run watch "$RUN" --exit-status
  ```
  `RUN` must be non-empty (a run built from exactly `$SHA`). If the run fails, **STOP**: do not tag, do not create the release; report the failed run's URL. The tag pushed next runs the image workflow again, which finds this commit's image for both platforms and skips.
- **Tag & Push**: Run `git tag <tag>` to create the tag locally on the version-bump commit, then run `git push origin <tag>` to push the tag (the commit went out with the image build). Push only that one tag, never `--tags`: GitHub starts no workflows for a push of more than three tags, and this tag starts the desktop installer build (`desktop-release.yml`, CGLAB-621).
- **Create Beta Release**: Run `gh release create <tag> agenfk-dist.tar.gz --prerelease --title "<title>" --notes "<notes>"`.
- Show the release URL returned by `gh`.
