# Changelog

All notable changes to AgEnFK are documented here.

## [2.0.0-beta.1] — 2026-09-24

Beta, cumulative over `1.1.21-beta.12`. Deterministic flow adherence (CGLAB-376): the server now enforces step
transitions instead of trusting the agent. Major version because forward moves and the final command change.

### Breaking

- **Forward moves go through `agenfk verify` only.** A forward `update --status` is refused (409) with a message
  naming `agenfk verify <id>`, and the internal token no longer lets anything land DONE.
- **The final step runs the project's own verify command.** A command passed to verify there is ignored, with a
  warning on the reply (never a 400, so older skills keep working).

### New

- **Step roles and a record-based check engine**: tree-clean, on-card-branch, jira-key-valid, the TDD red/green
  and test-surface checks, test-set identity, suite-green. Step snapshots and a test-report adapter record what
  each check needs.
- **Roles on the shipped DEFAULT and TDD flows**, and an independent review record (`agenfk review record`)
  checked against the reviewer's transcript.
- **Human gates on the board**: approve, and override a check with a reason; both appear on the PR. Optional
  passkey (WebAuthn) signing, set per step.
- **Friendly flow editor** (Kanban and Hub): role picker, check gallery, approvals, inline validation with
  one-click fixes, templates.
- **Per-step auto commit** (`autoCommit` / `requireCommit`): commits the card's staged, claimed work as it leaves
  a step, only once the advance is certain.

### Backwards compatibility

- Older CLIs, servers and editors keep working: unknown step fields are dropped by old installs, and an edit that
  omits them keeps the stored ones. A publish never strips a registry flow's roles, checks or commit settings;
  removing them on purpose takes `agenfk flow publish <id> --allow-removing-checks`.
- The MCP `create_flow` / `update_flow` tools carry the step contract.

### Fixes

- Codex verifies record the author (`CODEX_THREAD_ID`).
- Malformed test records on a card no longer make verify answer 500.
- The authority routes (passkeys, approvals, overrides) are rate limited; transcript paths are checked on the
  resolved path; PR-body table cells escape backslashes.

## [1.1.21-beta.12] — 2026-09-22

Beta, cumulative over `1.1.21-beta.11`. Proxy-derived URLs, and the flaky test suite fixed at its root (CGLAB-371).

### Behaviour change for hubs that set `AGENFK_HUB_PUBLIC_URL`

- **`AGENFK_HUB_PUBLIC_URL` now works.** It was documented (and set by the reference deployment) but read
  nowhere. It is now the origin of every URL the hub hands to others: invite join commands, the device-code
  approval link, `hubUrl` in join/redeem responses, a federation child's parent URL. A hub served on two
  hostnames hands out the canonical one, whichever the admin browsed - and `agenfk hub join <other-name>`
  saves the canonical name. Invalid values are refused at boot.
- **OAuth callbacks deliberately do not use it**: sign-in returns to the host it started on, so every
  hostname users browse must stay registered as a redirect URI at Google/Entra (unchanged).

### The hub no longer believes client-written forwarding headers

- **`X-Forwarded-Host` is not read at all.** The AWS ALB never sets it, so any value was written by the
  client - which let a repoint report claim to have "arrived on" the target host. The arrival host is the
  `Host` header (parsed properly, so IPv6 literals match). If your proxy rewrites `Host`, set
  `AGENFK_HUB_PUBLIC_URL`.
- The protocol (session cookie `Secure`, OAuth redirect) comes from Express's `req.secure`/`req.protocol`,
  which honour `X-Forwarded-Proto` only from the hops `AGENFK_HUB_TRUST_PROXY` trusts.
- The "cannot enrol with itself" guard recognises the hub under either of its names.

### Verify logs

- **A log that exactly filled `AGENFK_VERIFY_MAX_LOG_BYTES` was silently short.** The next chunk was dropped
  without the truncation flag or notice. Under load a pipe delivers exact 64 KiB reads, so this happened in
  practice; it now says it truncated.

### Test suite (contributors)

- **The wandering load-only failures are gone.** supertest bound the wildcard address but dialled
  `127.0.0.1`; macOS let that port be shared with another process's `127.0.0.1` listener, which then
  received the request (bare `ECONNRESET`, or a foreign 404/400). It now dials the loopback it bound.
  Reproduced with 656 squatting listeners: 8 of 14 files failing before, none after.
- **The UI suite no longer slows down as it runs.** jsdom 28.1 re-registers an unmounted `<style>`'s sheet
  (fixed upstream in 30.1), and each xterm terminal left ~1,580 CSS rules behind that every later query paid
  for - one AppShell spec hit the 20s timeout on CI. Orphaned sheets are dropped after each test:
  `AppShell.test.tsx` went from 80s to 11s.

## [1.1.21-beta.11] — 2026-09-22

Beta, cumulative over `1.1.21-beta.10`. Hub rate limits are per person where a person is known (CGLAB-371).

- **Dashboard (`/v1`), admin (`/v1/admin`) and `/auth/me` limits are keyed by the signed-in user**, not
  the client address. The hub is reached through shared corporate egress, so an address bucket was an
  office-wide cap: everyone behind one NAT or VPN shared 300 requests a minute. A cookie that does not
  verify (forged, expired, signed with an old secret) is charged to the address bucket, so it cannot buy
  a fresh budget.
- **`/auth/me` no longer mints a bucket per cookie value.** It keyed on the raw cookie string, so every
  forged value created an in-memory bucket kept for 15 minutes and was never refused.
- **The first refusal in each bucket's window is logged** as `[RATE_LIMIT] <method> <path> refused: over
  <limit> per <window> for one user|client address` - no address, no token. The load balancer keeps no
  access logs, so this is the only record that a limit is biting.
- Sign-in, device-code, invite redemption and first-run setup stay per address: there is no session yet.

## [1.1.21-beta.10] — 2026-09-22

Beta, cumulative over `1.1.21-beta.9`. Hub security hardening (CGLAB-371).

### The hub decides the client IP from how many proxies it trusts

- **New `AGENFK_HUB_TRUST_PROXY`**, default `1`. Behind a load balancer or reverse proxy the proxy
  *appends* the address it saw to `X-Forwarded-For`; the hub used to key every rate limit on the
  **first** entry - the part the client writes - so a fresh header per request bought a fresh budget
  (login, device-code, invite redemption). The client is now the hop the trusted proxy appended.
- `0` for a hub exposed directly (the compose quickstart now sets it), a hop count for a proxy chain,
  or a list of proxy addresses/CIDRs. `true`, more than 5 hops, and list entries that are not
  addresses are **refused at boot**, since each either trusts every hop or silently trusts none.
- Assumes the proxy appends (an ALB's default `xff_header_processing.mode=append`). An `ip:port`
  entry (ALB client ports) is keyed by its address.
- Upgrade-directive audit rows now record the real requester instead of the proxy's address.

### Invite redemption and first-run setup

- **`POST /hub/invite/redeem` is rate limited**, counting only failed attempts so a scripted rollout of
  many machines behind one office NAT completes. Invite tokens over 4096 characters are refused before
  their signature is checked.
- **`/setup/initial-admin` makes exactly one admin.** The bootstrap token is consumed inside the
  transaction that creates the admin, and a request that did not consume it creates nothing; every
  leftover token is cleared. The route is rate limited.

## [1.1.21-beta.9] — 2026-09-22

Beta, cumulative over `1.1.21-beta.8`.

### Federation: a parent hub is judged by the address it resolves to (CGLAB-371)

- A child hub's calls to its parent (enrolment, release requests, and the background ping, directives
  and delivery) now check the parent's **resolved** address as the connection is made, on the socket's
  own lookup. A public name pointing at a private address - or changing its answer after a check
  (DNS rebinding) - is refused before anything, the invite or the bearer token included, is sent.
- Private addresses are judged by range rather than by spelling, covering CGNAT (100.64/10, where one
  cloud's metadata service lives), NAT64 and 6to4 forms of private IPv4, and the other reserved ranges.
  The same ranges now apply to a parent URL written as an IP literal.
- **Behaviour change:** federation calls no longer go through `HTTP_PROXY`/`HTTPS_PROXY`. Behind a
  proxy the proxy resolves the parent itself, which the check cannot see, so these calls always dial
  directly. `AGENFK_HUB_ALLOW_PRIVATE_PARENT=1` still admits a parent on the private network.
- A refusal tells the admin why, without echoing the internal address (that goes to the server log).

### "Published by" names the GitHub login (CGLAB-372)

- A flow published through the hub now credits the laptop's GitHub login (from `gh`, pinned to
  github.com) when `gh` is signed in, falling back to the OS login. The lookup is bounded and never
  holds up the publish.

### Code-scanning fixes on the beta PR (CGLAB-371)

- **Hub rate limiting runs on `express-rate-limit`.** Same limits, same 429 with a JSON `error` and
  `Retry-After`; an IPv6 client is now bucketed by its /64, so rotating addresses no longer buys a
  fresh budget. The hand-rolled limiter it replaces was invisible to code scanning.
- **The JIRA OAuth routes are rate limited** on the local server (authorize and callback).
- **Hub query endpoints refuse a repeated or nested single-value parameter** (`from`, `to`,
  `limit`, `offset`, `bucket`) with a 400 naming it, instead of a 500. Repeated list filters are
  still merged.
- **`agenfk verify` no longer runs git inside the directory the caller reports.** The caller's path
  is matched against git's own list of the tested repository's checkouts; a caller in another
  checkout of the same repository is still refused, anything else is ignored.
- **Fix:** a verify issued from another project's checkout no longer re-records it as this project's
  root. The root is learned only when the recorded one is missing, is `$HOME`/`~/.agenfk`, or is a
  linked worktree - and such a root is now corrected by the next verify from the real checkout.

## [1.1.21-beta.8] — 2026-09-22

Beta, cumulative over `1.1.21-beta.7`.

### Publish goes to the org's own flow registry, as a pull request (CGLAB-367)

- In a hub-connected org that points its flow registry at its own repository, the flow editor's
  **Publish** now goes through the hub, which opens a pull request on that repository with the token
  it holds (the token never reaches a laptop). It used to push to the public community registry with
  the laptop's own `gh` login, whatever the org had chosen.
- One branch per flow, `flow/<slug>`: publishing again while its pull request is open updates that
  pull request instead of opening a second one. A changed flow is published one patch past the
  registry's version.
- The branch is only ever moved when that loses nothing: an open pull request into a different branch,
  or commits that are in no merged pull request, make the publish refuse and say why.
- No fallback to the public registry on any hub failure. An org on the public registry keeps
  publishing from the laptop, as before.
- The editor names the repository every publish went to.
- Hub admins: installations in the org can now open pull requests on the org registry as the stored
  token's GitHub account (rate-limited per installation and per org).

### Hub admins see the flow registry's open pull requests (CGLAB-368)

- Admin > Flows lists the open pull requests on the org's registry, marking the ones published from
  installations. Each opens on GitHub in a new tab for review and merge. It loads once and refreshes
  on request, because every fetch spends the org's token.

### `agenfk verify` follows the card's worktree (CGLAB-366)

- The verify command and the close commit now run in the card's worktree - its own, or its top-level
  item's, since children have none - instead of always in the project's main checkout, where another
  agent may be working.
- A linked git worktree can no longer be recorded as the project's root. A `.agenfk` marker inside one
  used to repoint every card in the project at that single worktree.
- Verifying from a different checkout of the same repository than the one the card is tested in is
  refused with an explanation, in both directions. A deleted worktree is reported as such.

## [1.1.21-beta.7] — 2026-09-22

Beta, cumulative over `1.1.21-beta.6`.

### Connect JIRA works again: no PKCE on the Atlassian OAuth flow (CGLAB-361)

- "Connect JIRA" dead-ended on Atlassian's "Something went wrong" page for every user. Atlassian's
  consent endpoint began returning HTTP 500 (`{"failedToLoad":true,"error":{"category":"generic"}}`)
  for any authorize request carrying `code_challenge`. Our request had not changed since February.
- Measured against live Atlassian by changing one variable: with only the PKCE parameters removed,
  the consent screen renders, Accept issues a code, and the code exchanges for access and refresh
  tokens without a `code_verifier`. The authorize redirect and the token exchange now carry no PKCE.
- The `state` nonce stays as the callback's CSRF protection and is now pinned by tests: issued by
  `/jira/oauth/authorize`, single-use, and refused once expired.
- Atlassian still documents PKCE support for 3LO, so this is a workaround for a change on their
  side; the code records the experiment so it is not restored blind.

### Hub shows the signed-in user's name instead of their UUID (CGLAB-354, PR #193)

- The hub's signed-in indicator displayed the account UUID; it now shows the user's name.
- `/auth/me` is rate-limited per session.
- The Postgres column migration behind the change is safe when several hub instances boot at once.

## [1.1.21-beta.6] — 2026-09-22

Beta, cumulative over `1.1.21-beta.5`.

### PR model detection reads the harness's own session identity (CGLAB-365)

- `agenfk pr create` / `pr-register` / `pr-resize` matched session logs on cwd and then on
  most-recent mtime, so two live sessions in one repo directory were indistinguishable: a
  Fable session's `--model` was "corrected" to `claude-opus-5` from a concurrent Opus
  session's transcript. The environment every tool shell receives names the session exactly —
  `CLAUDE_CODE_SESSION_ID` under Claude Code, `PI_SESSION_FILE` / `PI_MODEL` under pi — and
  is now read first; the cwd heuristic is only the fallback when nothing is named.
- A named session with no usable answer is final: a transcript with no model yet, a log
  older than the freshness bound (a dead session whose variable outlived it), or a Claude
  Code subagent writing concurrently (it shares the parent's id and may run another model)
  all leave the declared model in place as unverified rather than handing over to a sibling.
- `PI_SESSION_FILE` is honoured only under `~/.pi/agent/sessions/*.jsonl`; model ids are
  length-capped; `CLAUDE_CONFIG_DIR` is honoured on both paths.

## [1.1.21-beta.5] — 2026-09-22

Beta, cumulative over `1.1.21-beta.4`. Two parent-hub controls whose API had shipped
(CGLAB-182, CGLAB-183) but which nothing in the product could reach.

### Dispatch a flow to child hubs from Admin > Flows (CGLAB-358)

- Every org-owned flow gets a *Dispatch to child hubs* action with an all / selected child
  picker; `all` covers hubs that enrol later. A board below the flows list shows each dispatch
  with per-child pending / installed / failed state and a Cancel.
- A flow received from a parent can be relayed onward. The directives feed serves a hub's
  direct children only and a middle hub never re-dispatches what it installs, so relaying is
  the only route to grandchild hubs.
- A dispatch whose flow has since been deleted is labelled as unable to land and no longer
  keeps the board polling.

### Issue a group upgrade to child hubs from Admin > Upgrades (CGLAB-360)

- The Group upgrades section now always renders for a parent, with an *Upgrade child hubs*
  form: release list, the same child picker, and an explicit downgrade checkbox that travels
  as `confirmDowngrade` and is applied per installation by each child.
- `GET /v1/admin/upgrade/available-versions?unfiltered=1` skips the parent's own fleet floor,
  which says nothing about a child's fleet.
- `Flow.source` includes `'parent'` in the flow-editor and UI types.

## [1.1.21-beta.4] — 2026-09-18

Beta, cumulative over `1.1.21-beta.3`. Closes out the CGLAB-275 incident: every piece of
agent-facing output that misled the pi agent is now fixed, not only the rollback.

### The gatekeeper and the verify banner say what a step IS, never what to do on it (CGLAB-275)

- The gatekeeper's step-shape block printed `Coding step: DISCOVERY` on a TDD flow — the
  first non-anchor step, labelled as if it were where code is written. It now reads
  `First working step (the step after TODO): DISCOVERY` — the anchor's name comes from the
  flow, nothing is assumed to be called TODO or DONE — and the final-step line says plainly
  what happens there: `Final step (omit the command here; the project's verifyCommand runs
  and closes the item): REVIEW`.
- The shipped skill and slash commands called the first non-anchor step "the coding step"
  throughout, which is the same misread written down. They now say "first working step",
  and the rule against editing without a card says "an active working step".
- The verify success response's `MANDATORY EXIT CRITERIA` banner did not name the step the
  criteria belong to. After the silent rollback, the agent read the criteria of the step it
  had just re-entered as those of the step it believed it was on, and concluded that a
  no-command verify does not advance. The banner now reads `MANDATORY EXIT CRITERIA for
  <STEP> — the step this item is now on`, on both the TODO→first-step and the
  intermediate paths.

## [1.1.21-beta.3] — 2026-09-18

Beta, cumulative over `1.1.21-beta.2` (which shipped without its own entry here — it
carried the desktop installer fixes and the merge-conflict-marker cleanup in the rule
bundles, PR #182).

### A failed verify command refuses the advance; it no longer rolls the card back (CGLAB-275)

Observed on a TDD flow driven by a pi agent: the agent wrote red tests on the
"create unit tests" step — exactly what that step asked for — and passed pytest as the
verify command. The suite exited non-zero, and the server rolled the card back to the
flow's first non-anchor step, computed by position. On that flow the step is DISCOVERY,
two steps behind, and the failure response never said so. The agent then read the
criteria banner of a later verify as "still on the same step" and learned the wrong
lesson: that tests must pass to move between steps.

- A non-zero verify command on **any** step leaves the card **where it is**. The server
  cannot judge prose exit criteria, so the exit code of an optional command is not
  evidence the step failed. On the step before DONE the command is the gate, and there too
  the answer is "not DONE", not "back to the coding step".
- The code assumes only what a flow guarantees: a first anchor, ordered steps, a last
  anchor. No step name or position is consulted on the failure path any more.
- **Every verify response ends with the resulting status** ("Item is now on X" /
  "Item stays on X"), so an agent that truncates the output still sees where the card is.
- The `validate.failed` hub event carries `stayedOn` instead of `fellBackTo`.
- The skill, slash commands, README and SDLC no longer tell agents to pass a build
  command on every intermediate step: the command is optional there, and a step whose
  criteria expect red tests is not verified with the test runner.

## [1.1.21-beta.1] — 2026-09-18

Beta, cumulative over `1.1.20` (the merged stable line) — this branch carries the Electron
desktop epic (CGLAB-164) plus the fixes found while exercising it end to end.

### Runs are registered, reused, and attributed correctly (53ed7163, 9fece9e1, 43b37c93)

The desktop now records a run when it opens an agent (`PtyRegistry.registerRun`, with the
transcript glob the tailer follows); a re-registration of a session that is still running
reuses its row instead of opening a second one, keyed on session id, falling back to
card+harness for agents that cannot be handed an id. The recorder refuses a gatekeeper note
that names a DIFFERENT project, so one session's runs can no longer land on another's card,
and `agensfk run list --item` accepts an 8-char prefix like every other command.

### The terminal layout is a pane tree (7a717cb8, e488bcdd, ccbe7ba4, 992376b8)

Splits nest, `layoutPanes` draws one divider per split (each writing only its own node's
ratio), a tab can be dropped on a pane edge to split or moved to rearrange, tabs can be
reordered by dragging, every pane carries its own agent name and branch, and the header is
hidden once more than one pane is on screen. Four panes fit the width — wrapped lines and a
narrow-pane advice, never a horizontal scroller.

### See a file's diff from the worktree panel (be411ffb)

`GET /items/:id/diff` returns the unified diff of one file in the item's worktree (staged or
working tree, untracked shown as added), and the panel's rows open it in a modal.

### Packaging and releases

- The installer no longer generates `scripts/start-services.mjs` over a TRACKED repo file
  (ccc7e57c) — the script is shipped and read by `agenfk up`.
- The release job bumps with `bump-version.mjs` (internal refs included) and regenerates the
  lockfile, and marks a suffixed version as a GitHub PRE-release.
- macOS, Windows and Linux installers all build: a safe `executableName` for Linux, an
  explicit `artifactName` for deb/AppImage, `homepage` metadata, and signing that stays off
  unless a certificate is supplied (macOS was auto-discovering a runner identity and failing).

### Server correctness

`findProjectRoot` returns `null` when the walk finds no `.agenfk`, so a verify run from a
worktree can no longer repoint the project's `projectRoot` at one card's directory (957513e9);
the validate route is rate-limited; and the close commit runs git with argv rather than a
shell (c3d36f46).

## [1.1.20] — 2026-09-18

Stable, cumulative over `1.1.20-beta.1` and `1.1.20-beta.2` (PR #189). Both fixes were
exercised end-to-end in a fresh Docker install over SSH: install 1.1.19, upgrade to beta.1,
upgrade to beta.2, then re-run the npx bootstrap with and without `--beta`.

### `~/.agenfk-system` is pruned on upgrade (BUG 957c6c44)

Upgrades no longer keep files the new version dropped: the install dir is pruned against the
release-archive listing, repo-private release commands are filtered at every copy site, both
downgrade guards read the installed version before the overlay, `--dist-tarball` travels via
`AGENFK_DIST_TARBALL`, and leaked release commands are cleared in all three on-disk shapes.
Note that the first upgrade FROM a pre-1.1.20 install is still driven by the old CLI, which
does not hand the archive to the installer, so the install-dir prune takes effect from the
second upgrade on; the client-config cleanup runs on the first.

### The fleet-upgrade picker reads installations, not API keys (BUG bb27c0aa)

One row per machine from `GET /v1/admin/installations`; an unbound key binds itself to the
single machine it reports from; `POST /v1/admin/api-keys` rejects reserved `invite:` /
`device:` labels and no longer promises automatic binding.

### CI checks every layer of a stacked PR, not just the bottom one.

## [1.1.20-beta.2] — 2026-09-17

Cut from `fix/hub-installation-binding-integrity` (PR #190), stacked on
`1.1.20-beta.1` — it carries everything in that beta plus the changes below.

### The fleet-upgrade picker reads installations, not API keys (BUG bb27c0aa)

The admin Fleet-upgrades picker was built from `GET /v1/admin/api-keys` — one row per
**key**. Production showed 12 rows for 7 machines: one installation held six live keys and
rendered six times, `All (12)` was shown while `scope=all` targets nine, and two machines
were missing entirely because their live keys had no installation binding and were filtered
out.

Underneath it, an unbound key was not merely mislabelled but **inert**:
`GET /v1/upgrade-directive` returns `204` when a key has no installation binding (likewise
`/repoint-directive`; `PUT /flows/selection` returns 403), so two members' machines could
never receive a fleet upgrade at all — while `scope=all` still created target rows for them
that would sit `pending` forever.

- The picker now reads `GET /v1/admin/installations` — one row per **machine** — via a new
  pure module, with `api_keys` only as a display fallback, so labels come from live identity
  rather than the issue-time snapshot.
- An unbound key **binds itself** to the single machine it is demonstrably running on, on
  that machine's first report. The race-prone guards live inside the `UPDATE`, so there is
  no check-then-act window.
- `POST /v1/admin/api-keys` now **rejects reserved `invite:` / `device:` labels** with 400,
  so the onboarding prefixes stay hub-written by construction. Without that, a shared key
  labelled `device:ci-runner` would inherit the single-machine binding and every other
  machine on it would be refused as `foreign_installation`.
- That route also states plainly that the key it mints will **not** bind itself, instead of
  promising automatic binding, and points at `agenfk hub join`.

## [1.1.20-beta.1] — 2026-09-17

Cut from `fix/prune-system-dir-on-upgrade` (PR #189).

### `~/.agenfk-system` is pruned on upgrade (BUG 957c6c44)

Upgrades overlaid the install dir with a copy that deletes nothing, so any file removed
upstream survived there forever — and `scripts/install.mjs` then re-installed it into every
client's global config. That is how the repo-private `/agenfk-release` commands kept coming
back, and how one leaked into an unrelated project.

- The install dir is now pruned of files the new version no longer ships, against either the
  source tree or the release-archive listing, while keeping `dist/` and local state.
- Repo-private release commands are filtered at every copy site, which closes the second half
  of the bug: step 8f deleted them and step 10 immediately re-copied them undoing it.
- Both downgrade guards now read the **installed** version before the overlay overwrites
  `package.json` — previously each compared the npx ref with itself, so neither could see a
  beta install newer than `main`.
- `--dist-tarball` travels via `AGENFK_DIST_TARBALL` instead of being shell-interpolated; on
  Windows the interpolated path arrived mangled and the prune was silently skipped.
- Uninstall and install now clear the leaked command in all three on-disk shapes: flat
  (`~/.gemini/commands/agenfk-release.toml`), nested and AppleDouble (`._agenfk-release.toml`).

## [1.1.19] — 2026-09-16

Stable, cumulative over `1.1.19-beta.1`–`.5`.

### Hub-of-hubs federation (EPIC CGLAB-180)

A hub can enrol with another hub and report upstream, so an organisation running
several hubs sees one rollup without merging their databases: enrolment with
single-use HMAC invites, parent-granted leaving, flow dispatch, group upgrades
with per-hub progress, a child-hub facet on every rollup query, and the
guarantee that a child hub outlives its parent.

### Federation is configured from one place, and a join token is all you paste

`Admin → Organization` now carries the org identity, the parent hub and the
child-hub roster on one page; `/admin/child-hubs` and `/admin/parent-hub`
redirect to the matching section. A parent signs its own URL into the invites it
mints, so it emits ONE join code and the child pastes only a token, seeing the
host it will actually contact before it commits. The decoded URL is normalised
before it is shown or dialled, because `https://parent.example.com@evil.example.com`
reads as one host and connects to another.

**Upgrade ordering:** tokens minted before this change carry no address and are
refused. An upgraded child cannot join a parent still on an older version —
upgrade the parent hub first, then issue a fresh token.

### Cards can be linked to JIRA items outside of import (CGLAB-163)

### PR Overview searches by PR number (CGLAB-151)

### Tests no longer make real network connections

`TelemetryClient` built a live PostHog client with no test guard, so a single
`npm test` fired 24 real HTTPS requests to `app.posthog.com`. Telemetry is inert
under a test runner, the hub's federation worker no longer builds a real HTTP
transport there, and a suite-wide guard fails any socket to a non-loopback host.

### `agenfk pr create` reports the model that actually ran

Detection reads the harness session log (pi and Claude Code) and takes the last
model actually selected, instead of a session-independent default — a pi run on
DeepSeek was being attributed to the `qwen3.8:27b` in `settings.json`. The
guidance that caused it is corrected in all four rule bundles.

### Twelve bugs closed alongside the epic

Async `/v1` routes no longer hang the client on a DB error; `verifyCommand`
output is streamed rather than buffered; `AGENFK_HUB_ALLOW_PRIVATE_PARENT=1`
works; a hidden person's machine is not named to the parent; the DONE close
commit reports what it did and did not commit.

## [1.1.19-beta.5] — 2026-09-16

Cut from `feat/CGLAB-181_federation-enrollment` (PR #187). Cumulative: it carries
everything in `v1.1.19-beta.4` plus the changes below.

### `agenfk pr create` reports the model that actually ran

A pi session running DeepSeek v4.1 Flash had its PR attributed to Qwen 3.8 27b.
pi writes a `model_change` record per model selection — the first is the launch
default from `settings.json`, and a session that switches writes more. Nothing in
the CLI detected anything; the mechanism was prose, and the prose told agents to
read *"the harness's default/selected-model setting"*, which is exactly the
session-independent default that produced the wrong answer.

- `agenfk` now reads the harness's own session log (pi and Claude Code) and takes
  the **last** model actually selected. `pr create`, `pr-register` and
  `pr-resize` report that value, warning when it overrides a disagreeing
  `--model`. `--no-detect-model` keeps the declared value verbatim.
- An override is refused when the log comes from a different harness than the one
  declared, so a stale pi log cannot relabel a Codex run.
- Sentinel models (`<synthetic>`, written on cancelled turns) and subagent turns
  are ignored — a subagent runs a different model from the session that spawned
  it.
- When no session log matches, the command says the attribution is unverified
  rather than silently reporting the unchecked claim.
- The guidance is corrected in all four rule bundles and `agenfk-pr`: read the
  session log's last selection, never a default.

### Tests no longer make real network connections

`TelemetryClient` built a live PostHog client with `flushAt: 1` and no test
guard, so a single `npm test` fired 24 real HTTPS requests to `app.posthog.com`
— one per `packages/server` test file. Every developer's and every CI run was
shipping analytics to a third party, and the resulting sockets were the
intermittent `read ECONNRESET` that wandered between unrelated files.

- Telemetry is inert under a test runner (`AGENFK_TEST_ENABLE_TELEMETRY=1` to
  opt in). Production behaviour is unchanged.
- The hub's federation sync worker no longer lazily builds a real HTTP
  transport under a test runner — it started unconditionally and 70 of 71 hub
  test files inject none, so any test holding a parent binding had a timer
  dialling the host that binding named. An injected (fake) transport still
  ticks (`AGENFK_TEST_ENABLE_FEDERATION=1`).
- A suite-wide guard now fails any socket to a non-loopback host immediately,
  naming the host, so this class cannot regress silently. Loopback stays
  allowed — supertest opens an ephemeral `127.0.0.1` socket per request.

A separate, loopback-only `ECONNRESET` remains under investigation; it is
socket-lifecycle churn inside the suite, not an external dependency.

### Federation is configured from one place (CGLAB-181)

`Admin → Organization` held only the org-id rename, while "who reports to us"
and "who we report to" sat in two other tabs — three places for one subject.
Organization now carries all three. The two nav tabs are gone, and
`/admin/child-hubs` and `/admin/parent-hub` redirect to the matching section
rather than dead-ending.

### A join token is the only thing you paste (CGLAB-181)

A parent hub now signs its own URL into the child-hub invites it mints, so
"Generate join token" produces ONE code instead of a URL to pair with a token.
The child's join form is a single field: it decodes the token, shows the host it
will actually contact, and refuses to submit one that carries no address.

- The server takes the destination from the token and **ignores** any
  `parentUrl` sent alongside it, so neither a stale form field nor a doctored
  request can point an enrolment at a hub other than the one that issued the
  invite.
- The decoded URL is **normalised** before it is shown or dialled.
  `https://parent.example.com@evil.example.com` reads as one host and connects
  to another; the confirmation line is the only control a child hub has here, so
  it must be the string that gets requested.
- The child refuses an expired token, an installation invite, and a
  non-`child-hub` token locally, instead of relaying a confusing 4xx from
  whatever the token named.
- `isPrivateHost` now catches the IPv6 spellings of the addresses it already
  blocked — `[::ffff:127.0.0.1]`, unique-local and link-local — because this
  hostname now arrives in a token a stranger minted rather than typed by an
  admin. Mapped *public* addresses (`::ffff:8.8.8.8`) are still allowed.
- The parent's invite panel names the address baked into the token, so a
  misconfigured `X-Forwarded-Host` is caught where it can be fixed rather than
  on the receiving hub after the token has been sent.

**Upgrade ordering:** tokens minted before this change carry no address and are
refused, by deliberate choice — there is no URL field to fall back to. An
upgraded child therefore cannot join a parent still running an older version:
**upgrade the parent hub first**, then issue a fresh token. The on-screen
message says so.

## [1.1.19-beta.4] — 2026-09-16

Cut from `feat/CGLAB-181_federation-enrollment`, which branches off the
`feat/CGLAB-163_jira-item-linking` tip. Cumulative: it carries everything in
`v1.1.19-beta.3` — the CGLAB-151 PR-number search, the verifyCommand
diagnostics and the CGLAB-163 JIRA linking — plus the changes below.

### Hub-of-hubs federation (EPIC CGLAB-180)

A hub can now enrol with another hub and report upstream, so an organisation
running several hubs sees one rollup without merging their databases.

- **Enrolment (CGLAB-181).** A parent mints a single-use, 14-day HMAC invite of
  its own kind; a child redeems it for a federation key, which is a distinct
  principal from an installation api key — neither can act as the other. The
  parent gets a Child hubs roster (rename, detach, staleness); the child gets a
  Parent hub screen.
- **Leaving is parent-granted (CGLAB-181).** A child hub cannot let itself out
  of a group. It asks; the parent detaches it; only then does Leave work. The
  screen says so rather than offering a button the API refuses.
- **Flow dispatch (CGLAB-182).** A parent pushes flows to its children.
  Parent-origin flows are read-only on the child and unlock on detach, and a
  child reports each dispatch outcome upstream instead of the parent assuming.
- **Group upgrades (CGLAB-183).** An upgrade dispatched at the parent fans out
  through each child over its own installations, reports progress upstream, and
  can be cancelled mid-flight, with per-hub progress on the board.
- **Child-hub facet (CGLAB-184).** Every org-rollup query can be scoped to one
  or more child hubs. The facet persists to the URL rather than localStorage,
  because "here is what your hub contributes" is a thing one person sends
  another.
- **Standalone stays standalone (CGLAB-185).** A child hub outlives its parent:
  nothing about federation is load-bearing for a hub that never joined a group.
  Identity policy is adopted at enrolment, not on the first heartbeat, so a hub
  joining an opted-out group never forwards real identities.

### Twelve bugs closed alongside it

Every one found by review or by the epic's own work, each with a failing test
first:

- No `/v1` route can hang the client on a DB error any more — express 4 does
  not forward a rejected promise, so an async handler that threw sent no
  response at all.
- `verifyCommand` output is streamed rather than buffered, so a chatty command
  can no longer exhaust memory.
- The `types` filter works on `/v1/metrics`, and a date window means the same
  thing on both of its branches.
- `AGENFK_HUB_ALLOW_PRIVATE_PARENT=1` actually works — it used to get the join
  past the route's own check and then fail inside the binding write, spending
  the invite on every retry.
- A hidden person's machine is no longer named to the parent.
- Flow dispatch refuses untargetable hubs instead of silently dropping them.
- Back reaches the PR Overview's scalar controls, not just its facets.
- The device bearer no longer outlives its code.
- The PR hook reports the branch you pushed, not the redirection target.
- The DONE close commit carries what you staged rather than the whole working
  tree, and says what it left unstaged.

## [1.1.19-beta.3] — 2026-09-12

Cut from `feat/CGLAB-163_jira-item-linking`, which branches off the
`feat/CGLAB-151_pr-overview-pr-number-search` tip. Cumulative: it carries
everything in `v1.1.19-beta.2` — the CGLAB-151 PR-number search and the
verifyCommand diagnostics — plus the change below.

### Cards can be linked to JIRA items outside of import (CGLAB-163)

`externalId`/`externalUrl` have been on items since the JIRA importer landed,
and the board has always rendered them as a clickable badge. But only the JIRA
and GitHub imports ever wrote them: `POST /items` and `PUT /items/:id`
destructured a fixed field list that omitted both, so a card created any other
way could never point at an issue.

Now any card can:

```bash
agenfk create TASK "Fix the picker dismiss" --project <id> --jira-item CGLAB-163
agenfk update <id> --jira-item CGLAB-163     # link a card that already exists
agenfk update <id> --jira-item none          # unlink
```

The same `jiraItem` field works on `POST /items`, `PUT /items/:id`,
`POST /items/bulk`, and the `create_item` / `update_item` MCP tools.

**The link is a reference, not an import.** The card keeps its own title and
description; nothing is copied from JIRA and nothing is overwritten. Use the
importer when you want the issue's content.

**Validation depends on the connection.** With JIRA connected the key is checked
against the real issue and the browse URL is derived from the token's cloud URL;
a key that does not resolve is refused. Without a connection the key is
format-checked and stored bare — which is what makes this usable offline and in
CI. If JIRA is connected but unreachable the link still goes through and the
command says it could not be verified, rather than reporting a plain success.

Leaving the flag off never changes an existing link, so an ordinary
`agenfk update <id> --title "..."` cannot silently drop a card's reference.

The capability is documented in every shipped client bundle — `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, `agenfk.mdc` — plus `SKILL.md` and the `/agenfk` and
`/agenfk-plan` commands.

### Fixed along the way

- **A JIRA reference with no browse URL now renders.** Both the board and the
  card detail modal gated their badge on `externalUrl`, so a card linked while
  disconnected — the documented offline mode — showed no reference at all.
- **`agenfk list --active` is documented for every client.** It was in the
  Claude bundle only, while all four bundles instruct the agent to use it, so
  Codex, Gemini and Cursor agents were told to use a flag their own command
  reference did not list.
- **`POST /items/bulk` reports failed writes.** A `storage.updateItem` throw was
  caught, logged and reported as nothing, so a failed entry looked like a
  success. It now appears in `skipped`, alongside a new `warnings` array for
  entries that applied with a caveat. Both fields are additive.
- **Outbound JIRA calls are bounded.** Neither the API request helper nor the
  token refresh it falls back to on a 401 set a timeout, so a stalled Atlassian
  endpoint could hang a request indefinitely. Both now carry one.
- **`externalUrl` is validated.** The board renders it straight into an `href`,
  so the server refuses anything that is not `http(s)`, and refuses embedded
  credentials.

### Behaviour change

`PUT /items/:id` now validates a requested type change and parent assignment
*before* handling an archive transition. Previously an archiving request skipped
both guards, so `{ status: "ARCHIVED", type: "BOGUS" }` archived the item; it now
returns 400. Archiving without those fields is unaffected.

## [1.1.19-beta.2] — 2026-09-10

Also cut from `feat/CGLAB-151_pr-overview-pr-number-search`, piling on
`v1.1.19-beta.1`. Cumulative: it still carries the CGLAB-151 PR-number search
plus everything below.

### A failing verifyCommand now says what happened (BUG b233143b)

The exit code was captured server-side, used to decide pass/fail, and thrown
away. Three different failures read identically as `Validation Failed!`: a red
test suite (1), a command killed by the runtime cap (124), and a command that
could not be spawned at all (127). The only view of output was a head-1KB +
tail-1KB slice of a raw byte stream, and the full log sat under the database
directory — on a system install `~/.agenfk-system/.agenfk/logs`, pruned to three
files and named only in a trailer.

The failure message now leads with the outcome (exit code, the signal that killed
it, or the runtime cap), repeats the **last** 25 lines rather than the first, and
names the log path.

**Validation logs moved.** They are written to
`$TMPDIR/agenfk-verify-<uid>/<itemId>/<testId>.log`; the previous
`<dbDir>/logs/` location is no longer used. The directory is `0700` and the file
`0600` because the temp dir is world-writable and command output routinely echoes
environment — tokens, connection strings. Fixed at the same time: the root is now
checked with `lstat` (`stat` follows symlinks, so the ownership check was
answering "is the thing at the other end mine?"), the file mode is real via an
exclusive-create flag, the prune can no longer delete the log the same response
just promised, and `DELETE /projects/:id` purges logs before hard-deleting the
rows that made them unreachable.

Implemented server-side, so `agenfk verify` and MCP `validate_progress` both get
it. A command that reports progress with carriage returns no longer floods the
response: the tail is split on `\r` as well as `\n` and capped in bytes.

### The upgrade check can no longer resolve a hub release (BUG b233143b)

Cutting `hub-v1.1.19-beta.1` — the hub-only Docker image line — created it
without `--prerelease`, so GitHub counted a hub build as the latest **stable**
release. Every CLI then reported `vhub-v1.1.19-beta.1 is available`, and
`agenfk upgrade` would have tried to install a Docker image tag.

That is worse than a wrong banner. `parseSemver` fails on a hub tag, the
comparison falls back to a string compare that ranks letters above digits, so the
tag read as a newer release — and the upgrade tier ships with it, where
`mandatory` makes every CLI invocation exit 1.

`isHubRelease` now lives in `@agenfk/core` beside the comparison it defeats;
`isUpgrade` refuses an unparseable version; all three CLI sources (including the
one-hour cache) reduce through one guarded function; and `GET /releases/latest`
re-queries the release list rather than promoting a hub tag. `hub-image.yml` marks
hub prereleases `--prerelease` and stable hub builds `--latest=false`, so the bad
state cannot be created again. The CLI's gh calls moved off shell interpolation.

## [1.1.19-beta.1] — 2026-09-10

Cut from `feat/CGLAB-151_pr-overview-pr-number-search` rather than `main`, so the
PR-number search can be exercised before the branch merges. It carries CGLAB-151
and nothing else that is sitting unmerged.

### Hub-ui — find one PR by number on the Overview page (CGLAB-151)

A PR number is the one identifier a developer actually has, and it was the one
thing the Overview could not take. The number is unique per repo, so it is also
the question the page was structurally unable to answer: the route pushes a time
bound into SQL and applies the model/developer filters, so a PR opened outside
the visible window simply was not there to find.

- **The search box supersedes every filter except Project.** Date range (preset
  or explicit), model and developer are dropped from the request — not sent
  alongside the number — so a stale `?model=` left in a shared URL cannot quietly
  narrow the answer to zero rows. Project stays live because a PR number is only
  unique within one repo; the same number in two repos shows both, by design.
- **It takes the forms people actually have.** `57`, `#57` copied out of the
  GitHub header, or a pasted URL — GitHub, GitLab `merge_requests`, and both
  Bitbucket spellings (`pull-requests` on Server/DC, `pullrequests` on Cloud).
  Anything that is not a number means *no search*, so a half-typed box leaves the
  normal window on screen instead of an empty page that reads as lost data.
- **Superseded controls go grey, not missing**, and keep their selection, so
  clearing the search restores it in front of the user. An open popover closes
  when its facet is disabled — otherwise it is a keyboard trap over inert options.

### Hub — `?pr=` on `/v1/prs/overview`

When the param is present the route lifts the SQL upper bound (otherwise a re-size
event after `to` is invisible and the PR reports a stale size), skips the model
and developer filters, and skips the previous-period delta — a comparison window
is meaningless for a single PR.

### Decisions worth knowing about

- **A search's day axis is the days its rows actually appear on**, not a derived
  range. A contiguous axis over a span wider than 366 days hits `buildDayAxis`'s
  cap and silently drops the overflow: the KPI tile counted 2 PRs while the chart
  drew 1, and the dropped PR had no cell to drill into. An axis built from the
  data cannot truncate, because it is the data — and it is deliberately
  **unbounded**, so a PR open for three years renders ~1000 columns. Long is
  allowed to look long; quietly wrong is not.
- **Typing does not machine-gun the API.** A PR search has no time bound, so every
  committed query is an org-wide scan; the request waits 350ms for a pause while
  the box, the disabled controls and the results keep up.
- **Copy describes the rows, not the request in flight.** With the previous answer
  held on screen during a load, `data` and the live query key belong to different
  requests — which is how "Showing PR #57 only" came to sit over the window's
  table, and an empty heatmap came to sit under "Total PRs 1". `useSettledKey`
  pins every claim about the data to the query that produced it.

## [1.1.18] — 2026-09-08

Stable, cumulative over `1.1.18-beta.1`–`.4`. Everything here shipped to the
hub in production on this date.

### Hub — admin-settable private flow registry (CGLAB-138)

- **Per-org flow registry.** A hub admin points their org's flow registry at an
  existing private repo; community flows are copied into it once, on select,
  rather than referenced across repos.
- **Browse the community registry alongside a private one.** Pointing the org at
  a private repo used to make the real community catalogue invisible and
  uninstallable. The registry tab now offers a switcher between the org's repo
  and Community.
- **The caller picks a source, never a repo.** `?source=org|community` is an
  enum and an `owner/repo` in the query is ignored — this route holds the org's
  `contents:write` PAT, so a caller-supplied repo would turn it into a
  cross-tenant proxy on a server-side credential. Community reads are always
  anonymous for the same reason.

### Hub — flow editor labels and footer CTAs

- **Tab captions say what they list.** "My Flows" → **"Org Flows"** in the hub
  admin, and the registry tab is named for the repo it is actually reading
  instead of always claiming "Community".
- **Footer buttons name the write.** `Save` / `Publish` / `Use this Flow` read
  as one pipeline but were three unrelated writes. The hub now labels them
  **"Save & publish to org"** / **"Published to org"** / **"Set as org
  default"**, and the registry-config form's button is **"Save registry repo"**
  so the page no longer shows two Save buttons.
- **Publish is capability-gated.** `RegistryClient.publishToRegistry` is now
  optional; the hub has no publish route, so it omits the method and the editor
  no longer renders a button that could only throw. Use
  `agenfk flow publish <id> [--registry owner/repo]` for a registry PR.
- **Binding saves first.** "Set as org default" used to bind the id it already
  had, so with unsaved edits it assigned the server's version, reported success,
  and **silently dropped the edits**. It now persists before binding; a failed
  save means no bind.
- **A newly created flow is no longer a dead end.** Two footers were chosen by
  read-only-ness, stranding a flow with no id: no Save (other branch) and no
  Publish (that branch gated on `flow?.id`). One footer now gates per
  capability.

### CLI / pi harness

- **The pi harness no longer misreports the model** in PR registration —
  `settings.json` `defaultModel` is a startup default, not the live model, and
  it was overwriting a correct `--model`.

## [1.1.18-beta.4] — 2026-09-08

### Hub — the flow editor's footer buttons now say what they write

`Save` / `Publish` / `Use this Flow` read as one pipeline. They were three
unrelated writes, and two of them promised more than they did.

- **Publish is capability-gated, not decorative.** `RegistryClient.publishToRegistry`
  is now optional. The hub holds the org's registry PAT and has no publish
  route, so the hub admin omits the method and the editor no longer renders a
  button that could only throw. Authors who need a registry PR use
  `agenfk flow publish <id> [--registry owner/repo]`.
- **Labels name the write.** The hub host now passes
  **"Save & publish to org"** / **"Published to org"** / **"Set as org
  default"** — the last one being the literal badge the flows list renders for
  the same assignment. The registry-config form's button is renamed **"Save
  registry repo"**, so the page no longer shows two Save buttons.
- **Binding saves first.** "Set as org default" used to bind the id it already
  had, so with unsaved edits in the panel it assigned the version already on the
  server and reported success while **silently dropping the edits**. It now
  persists before binding, and a failed save means no bind.
- **A newly created flow is no longer a dead end.** Two footers used to be
  chosen by read-only-ness, which stranded a flow with no id yet: no Save (it
  lived in the other branch) and no Publish (that branch gated on `flow?.id`).
  One footer now gates per capability.
- **Two pre-existing bugs fixed on the way:** the "Saved" badge could never
  display — a save churned selection state, remounting the panel by `key` and
  discarding the dirty baseline — and the load effect keyed on the `flow` object
  rather than `flow?.id`, so it re-ran with a stale object after every save.

## [1.1.18-beta.3] — 2026-09-07

### Hub — browse the community registry alongside a private one

- After an org points its registry at a private repo, the hub could only ever
  read that one repo — so the real community catalogue became invisible and
  uninstallable, and any flow published to community afterwards was
  unreachable. Admin → Flows → the registry tab now offers a **switcher**
  between the org's repo and Community.
- **The caller picks a source, never a repo.** `?source=org|community` is an
  enum; an `owner/repo` in the query is ignored. This route holds the org's
  `contents:write` PAT, so a caller-supplied repo would make it a cross-tenant
  proxy on a server-side credential.
- **Community reads are always anonymous.** The org's PAT is scoped to the org's
  repo; sending it to the public repo would leak the credential to a repo the
  org has no relationship with.
- **Tab captions now say what they list.** "My Flows" → **"Org Flows"** in the
  hub admin (it is the org-wide catalogue, not a personal list), and the
  registry tab is named for the repo it is actually reading instead of always
  claiming "Community". The standalone client is unchanged.

## [1.1.18-beta.2] — 2026-09-05

### Hub — admin-settable private flow registry (CGLAB-138)

- **Per-org flow registry.** A Hub admin can point their org's flow registry at
  an **existing** repository of their own instead of the public
  `cglab-public/agenfk-flows`. Admin → Flows → Flow registry.
- **The save fails if the repo cannot be written.** Write access is probed
  before anything is persisted, so an admin is never left believing the fleet
  points at a registry that serves nothing.
- **One-time community copy.** Switching copies the community flows present at
  that moment into the org repo; it is not a mirror. A re-runnable *Retry copy*
  recovers a partial run and is idempotent by content.
- **Token held on the hub, encrypted.** A fine-grained PAT (`contents:write`) is
  stored `encryptSecret`-encrypted in the new `org_settings` table and is never
  returned by any endpoint. Registry reads are authenticated with it — GitHub
  answers an anonymous fetch of a private repo with `404`, so a private registry
  cannot be served to a fleet otherwise.
- **Reversible.** Moving back to the public repo needs no reverse copy.
- **Branch is validated, not just the repo.** A malformed ref is worse than a
  malformed repo: GitHub answers an unknown `ref` with `404`, and an empty
  registry is read as `404`, so a stored-but-unusable branch would show an admin
  a registry of **zero flows and no error**. `isValidRegistryBranch` rejects it
  at the storage boundary and at the route, before any GitHub call.
- **No silent public fall-back.** When the Hub is unreachable, a connected
  installation's `/registry/flows` returns `502` rather than showing the
  community catalogue the org deliberately sealed away.

## [1.1.18-beta.1] — 2026-09-05

### Fixed

- **Pi harness misreported the model in PR registration.** The session's live
  model is used instead of the `settings.json` `defaultModel`, which is a
  configured default and not the model actually answering.

## [1.1.17] — 2026-09-04

Stable release. Consolidates `v1.1.17-beta.1` … `v1.1.17-beta.15` (PR #175).

### PR volume granularity (CGLAB-133)

- The PR Overview reports PR **volume and size granularity** rather than a single
  aggregate, so a team's PR throughput is legible instead of being one number.

### Hub — model provider / license is configurable, not hardcoded

- **New `model_meta` table** (SQLite + Postgres), keyed `(org_id, model)` with
  `provider`, `license_class` (CHECK-constrained to `open_weights|commercial`),
  `license`, `source` (`seed`|`admin`).
- **Seeded automatically** from a curated 102-row table (each row checked against
  the vendor's licence text / model card) on an org's first read. The table is the
  source of truth afterwards, so a future seed refresh can never overwrite an
  operator's corrections.
- **Admin → Models is one table with inline editing.** One row per model name,
  alias spellings nested underneath, provider / weights / licence edited in place
  (Enter commits, Esc discards). A new model arrives **Unknown** and sorts to the
  top rather than inheriting a vendor by string similarity. Family rules are
  labelled (`from glm-`, `covers N`) so prefix matching is not invisible magic.
  Unmap lives on the alias row, since unmapping is about a spelling.
- **API**: `PUT`/`DELETE /v1/admin/models/meta`, `meta` on `GET /v1/admin/models`;
  `/v1/prs/overview` returns `provider` / `licenseClass` / `license` per `byModel`
  row.
- **Unclassified is never reported as Commercial.** An unknown model has no
  established licence; claiming one put models in the "Commercial / API only"
  facet on no evidence. `unclassified` is its own bucket end to end.

### PR Overview filters

- Filters collapse into an accordion (`?filters=0` when collapsed) with an
  "N active" summary, so a hidden filter cannot silently change the numbers.
- **Model meta-filter** selects models by provider and open-weights/commercial.
  It is a *selector* that writes model ids into the existing `?model=` CSV — no
  new filter axis, so shared links restore the same view.

### Fixes found in production during the betas

- **Mapped models lost their provider metadata.** Metadata is resolved from the
  raw reported id while `byModel` is keyed by the canonical name; with a mapping
  the keys differed and the row shipped with no classification at all. Every
  model reached through an alias mapping was affected.
- **Admin → Models rendered two tables** and had lost its unmap control when the
  sections were merged; both restored, plus mappings whose alias has not been
  reported yet (previously counted but rendered nowhere).

### Test suite: 218s → ~60s

- Configurable bcrypt cost (`AGENFK_HUB_BCRYPT_ROUNDS`, prod default 11, pinned to
  4 in tests) — the dominant cost was hashing in test setup.
- Vitest split into `parallel` / `serial` projects, and hub specs drain the Fastify
  app on teardown instead of leaking handles.
- Full suite **2813 tests / 245 files**.

### Notes

- `normaliseModelId` does not fold `:`, so an Ollama-style id (`qwen3.8:27b`)
  resolves through the shorter family rule rather than the specific artifact row.
  Correct today; pinned in a test so client and server normalisers cannot drift.
- `model_meta` was added to `ORG_ID_CHILD_TABLES`; without it an org rename would
  orphan the rows and silently re-seed defaults.

## [1.1.17-beta.15] — 2026-09-04

### Fix — a model could be "Open weights" in Admin and "Unclassified / Commercial" on the dashboard

Reported as: `deepseek-v4-pro-0813` shows DeepSeek / open weights in Admin →
Models, but **Unclassified** *and* **Commercial** in the PR Overview. Verified
against the production database — `model_meta` had 8 DeepSeek rows, all
`source='seed'`, no admin edits. **The seed was never the problem.**

Two independent bugs:

1. **A join bug — the visible one.** Provider/license metadata is resolved from
   the **raw reported id**, but `byModel` is keyed by the **canonical name** after
   alias resolution. When a mapping exists the two keys differ, the lookup misses,
   and the row ships with no `provider`/`licenseClass` at all. Production has
   exactly this mapping: `deepseek/deepseek-v4-pro-0813` → `deepseek-v4-pro-0813`.
   Its *unmapped* siblings classified correctly, which is what made this look like
   bad data rather than a broken join. Fixed by carrying the raw id through
   aggregation and resolving metadata through it.
2. **A fabricated class — the reason it said "Commercial".** Both the server's
   unclassified sentinel and the client's fallback hardcoded
   `licenseClass: 'commercial'` for anything they could not classify. A model with
   no established licence was therefore reported as *Commercial / API only* and
   appeared in that facet — a claim about a licence nobody granted. `unclassified`
   is now its own bucket end to end: visible, filterable, never an assertion. The
   `model_meta` column stays CHECK-constrained to `open_weights|commercial` (it
   stores facts); the API may report `unclassified` (it reports what is known).

**Which models were affected:** every model reached through an alias mapping —
in production that is all seven: `deepseek/deepseek-v4-flash`,
`deepseek/deepseek-v4-flash-0731`, `deepseek/deepseek-v4-pro-0813`,
`@cf/zai-org/glm-5.2`, `z-ai/glm-5.2`, `moonshotai/kimi-k3`, `qwen38-27b`. Any of
them that looked Unclassified/Commercial should now show their real seed values.

Tests: 3 hub e2e (mapped model keeps metadata, router-prefixed alias, genuinely
unknown stays unclassified) and 2 client assertions that had been pinning the
fabrication were flipped to pin unknown-instead-of-commercial. Full suite
**2813 tests / 245 files** green.

## [1.1.17-beta.14] — 2026-09-04

### Fix — Admin → Models rendered two tables, and could not unmap

Both regressions shipped in `v1.1.17-beta.13` and were caught in the deployed UI.

- **The old mappings table was never deleted**, so the page showed it on top and
  the new unified table below. The previous commit inserted the new component and
  removed only the "Provider & license" section — the mappings `<section>` was
  left behind.
- **The unified table had no unmap control.** Unmap lived on the rows of the table
  that got deleted, so the affordance disappeared with it. It now sits on each
  **alias** row: unmapping is about a reported spelling, so it must not sit on the
  model row where it would read as "unmap this model".

Also restored what the deleted table showed and the new one silently dropped:

- **"N unmapped"** warning for names that are each their own group — the exact
  condition mapping exists to fix.
- **Mappings whose alias has not been reported yet** now get a row, marked
  "not reported yet", with unmap available. Previously they were counted in the
  "N aliases" label but rendered nowhere, so a mapping you had just created was
  invisible and irreversible until an agent happened to report that spelling.

Tests: 3 new (unmap on the alias row, pending mapping visible and unmapbable, no
unmap on the model row). The 4 page assertions that named the removed markup were
retargeted to the new labels, not loosened. Full suite **2810 tests / 245 files**
green.

## [1.1.17-beta.13] — 2026-09-04

### Hub — Models admin is one table now, edited inline

The previous cut shipped two sections on Admin → Models — alias mappings, and a
separate read-only "Provider & license" table with an add-form. They described
the same thing, so they are one table now.

- **One row per model name.** Aliases nest underneath it; Provider / Weights /
  Licence sit on the same row. **Click a value to edit it in place** — Save and
  Cancel in the row, Enter to commit, Esc to discard. The add-form is gone:
  correcting a row and adding one are the same upsert against
  `PUT /v1/admin/models/meta`.
- **Classification attaches to the model name, never to a spelling.** Aliasing
  keys on a reported spelling (`qwen38-27b` → `qwen3.8-27b`); provider and
  licence key on the name the dashboard groups and filters by. Classifying a
  spelling would let one model carry two licences depending on which agent
  reported it, so alias rows are shown but not editable on that axis.
- **A new model arrives Unknown.** No matching rule means the row reads
  `Unknown` in amber, sorts to the top of the table, and offers "Classify this
  model" — it does not inherit a vendor by string similarity. The header counts
  how many are unknown.
- **Prefix rules are visible, not magic.** A row classified by a family rule
  says `from glm-` and `covers N`, so a rule governing models off-screen is
  legible. Save is gated on the row actually changing, because saving an
  untouched inherited rule would silently narrow the family rule to one model.
- **Noise stays out of the way.** Only models actually reported are listed by
  default; the ~100 seeded rules that matched nothing sit behind "Show all
  classification rules". Without that, the page is mostly rules for models you
  do not run.
- Validation (blank provider, blank licence, invalid class, harness names) runs
  as you type, not only on save.

### Notes found while building this

- **`normaliseModelId` does not fold `:`**, so an Ollama-style id
  (`qwen3.8:27b`) normalises to `qwen3-8:27b` and resolves through the shorter
  `qwen3-8` family rule rather than the specific `qwen3.8-27b` row. Both say
  Apache-2.0, so the answer is correct today; the specificity loss only bites
  where a family rule and its artifact rule disagree (as with `glm-5.3` vs
  `glm-5.3-flash`). Pinned in a test rather than changed, so the client and
  server normalisers cannot drift apart unnoticed.
- Model names now appear twice in the DOM by design (datalist suggestions and
  table rows), so the existing page tests were scoped to the table instead of
  loosened.

### Testing

27 tests for the merge rules (longest-prefix wins, unknown stays unknown,
inherited-rule narrowing, scope filtering), 15 for the table (inline save,
classify-from-unknown, Save disabled on no-op and on invalid, delete leaves the
model unknown, scope toggle). Full suite **2806 tests / 245 files** green.

## [1.1.17-beta.12] — 2026-09-04

### Hub — model provider/license is now configurable

The Provider / Open-weights / Commercial facets shipped in `v1.1.17-beta.11`
were a hardcoded table in the browser bundle with no way to change them. They
are now a database table an admin edits.

- **New `model_meta` table** (SQLite + Postgres), keyed `(org_id, model)` with
  `provider`, `license_class` (`open_weights` | `commercial`, CHECK-constrained),
  `license`, and `source` (`seed` | `admin`).
- **Seeded automatically** — on an org’s first read the table is populated from
  a curated 102-row seed (`packages/hub/src/util/modelMetaSeed.ts`, each row
  checked against the vendor’s own licence text / model card). Works out of the
  box; **the table is the source of truth afterwards**, so shipping a new seed
  can never overwrite an operator’s corrections.
- **Admin → Models** gains a “Provider & license” section: search the ~100 rows,
  correct one, or add a model the seed does not cover. Admin-edited rows sort
  first and are labelled, so the page is verifiable at a glance. Saving marks
  `source='admin'`, which is what survives a future seed refresh.
- **API**: `PUT /v1/admin/models/meta`, `DELETE /v1/admin/models/meta/:model`,
  and `meta` on `GET /v1/admin/models`. `/v1/prs/overview` now returns
  `provider` / `licenseClass` / `license` on each `byModel` row.
- **The client-side seed was deleted.** Two copies would have meant an admin
  edit in the UI silently not affecting what the browser filtered by — the
  failure mode that makes a settings page worse than no settings page. The
  facet now derives everything from the API response.
- Matching stays **artifact-level, longest-prefix-wins**, on a normalised id
  (router prefixes like `@cf/zai-org/…` stripped), because one family spans both
  classes: `qwen3.8-27b` is Apache-2.0 open weights while `qwen3.8-max` is
  API-only. Harness names (`claude-code`) are rejected by the API and never
  classified as models. Unmatched models stay **unclassified** — visible and
  filterable, never guessed.
- **Org rename**: `model_meta` was added to `ORG_ID_CHILD_TABLES`. Without it,
  renaming an org would orphan its metadata rows under the old id and silently
  re-seed the org from defaults. Caught by the existing schema regression pin.

### Testing

- 20 new hub e2e tests (seeding once-per-org, admin override reaching the
  dashboard, per-org isolation, validation, harness rejection, router-prefix
  resolution), 18 for the admin helpers, 19 rewritten for the derivation-only
  client module. Full suite **2764 tests / 243 files** green.

## [1.1.17-beta.11] — 2026-09-04

### Hub — PR Overview

- **Collapsible filter bar** — the Project / Developer / Model facets were
  stacked vertically and pushed the charts below the fold. They now live in an
  accordion. Collapsing does **not** deactivate the filters: the header shows an
  "N active" badge and a per-facet summary, so a hidden filter can never
  silently change the numbers. Open/closed is stored in the URL (`filters=0`,
  only when collapsed) rather than localStorage, so a shared or bookmarked link
  restores the same layout like every other filter on the page. Open by default.
- **Model meta-filter** — select/deselect models by **vendor** (Z.ai, Anthropic,
  OpenAI, Alibaba, …) and by **license class** (**Open weights** / **Commercial
  · API only**) instead of searching a long model list one chip at a time.
  - It is a *selector*, not a new filter axis: a click resolves to model ids and
    writes them into the existing `?model=` CSV. **No API or SQL change**, and a
    shared link restores the same view. It only *adds* — models you picked
    individually are never dropped.
  - Each chip shows how many models it would add, and a vendor with nothing left
    to add is disabled rather than hidden, so "already all selected" is legible.
  - A per-selection breakdown lists each selected model's vendor, class and
    exact licence, so the classification is verifiable rather than a claim.
- **Model provider/license seed** (`modelMeta.ts`) — the hub stores `model` as
  free text an agent self-reports and has no provider or license column, so
  these facets are derived from a curated, artifact-level table (sources: each
  vendor's own licence text / model card, checked Sep 2026). Deliberate choices:
  - **Artifact-level, longest-prefix-wins**, because one family spans both
    classes: `qwen3.8-27b` is Apache-2.0 open weights while `qwen3.8-max` is
    API-only, and `glm-5.3-flash` is MIT while `glm-5.3` is a bespoke licence.
    A family-level rule is wrong for one of every such pair, silently.
  - **Unmatched models are "Unclassified", never guessed** — a visible,
    filterable bucket, so a new model is not silently mislabelled.
  - Router prefixes are stripped before matching (`@cf/zai-org/glm-5.2`,
    `openrouter/anthropic/claude-opus-4-8`), and **harness names are not
    models**: `claude-code` is reported in the model axis and must not classify
    as an Anthropic model.
  - Per product decision, **downloadable weights win ties**, so bespoke-licence
    models (Kimi K3, GLM-5.3, Qwen3.8-Flash-Next, Llama 4) count as open
    weights. That makes this axis open **weights**, not open **source** — the UI
    says so and the tooltip names the actual licence.
  - Display/filter only: nothing is persisted and the stored model id is never
    rewritten. Admin-curated overrides remain a follow-up.

### Testing

- 33 unit tests for `modelMeta` (the split-family traps, harness strings,
  router prefixes, the no-guess contract) and 16 page/component tests for the
  accordion + meta-filter. Full suite 2740 tests / 241 files green.

## [1.1.17-beta.10] — 2026-09-03

Carries the CGLAB-133 hub changes forward from `v1.1.17-beta.9` and adds the
test-suite performance work. Deployed to production hub
(`afk-hub.cglab.com`, verified via `/healthz`).

### Hub — PR Overview

- **Selectable granularity** (CGLAB-133, #175) — the "PR volume by size" chart
  buckets **daily / weekly (ISO, Mon–Sun) / monthly**, with **Total / Avg / Max**
  stats under the chart. Re-bucketed client-side from the API's existing
  per-UTC-day `byDay` array, so no API or SQL change and counts stay identical
  to the heatmap and the per-cell drill-down. Week starts are UTC-anchored (a
  Sunday stays in the week that began Monday); `average` divides by every bucket
  in the range including empty ones, `max` names its bucket and breaks ties to
  the earliest. Tooltips carry the bucket's non-empty days. New pure module
  `prVolumeGranularity.ts` (24 unit tests + mutation-sweep assertions).

### Testing

- **Full-suite wall clock: ~218s → ~58s** (3.7×) from the two changes below.
  Measured on the same machine, same 238 files / 2667 tests.
- **bcrypt cost is now configurable** via `AGENFK_HUB_BCRYPT_ROUNDS`
  (production default unchanged at 11, clamped to bcryptjs' valid 4..31,
  non-numeric falls back to the default). The vitest env pins it to 4: the hub
  suite performs ~238 **synchronous** bcrypt ops (114 user creations + 124
  logins) which at rounds=11 cost ~23s of blocked worker per full run. The hash
  format is identical at cost 4, so signup/login/rotation paths stay exercised
  end to end — new `bcrypt-rounds.test.ts` pins the default, the clamping, lazy
  env reads, and that a reduced-cost hash still verifies.
- **Split vitest projects by filesystem coupling** (`vitest.config.ts`): the
  fs-free packages (core, hub-ui, ui, flow-editor, plus storage-sqlite/telemetry,
  which use per-file mkdtemp dirs or a mocked `os.homedir()`) now run their
  files concurrently in a `parallel` project, while server/hub/cli stay in a
  serial project. The previous blanket `fileParallelism: false` was serialising
  ~90 files that had nothing to contend over. Timeouts, aliases, the HOME pin
  and the coverage gate are shared from `scripts/vitest-shared-config.mjs` so
  the two projects cannot drift.
- **Hub test teardown now drains the ephemeral supertest listener** before
  closing the WAL-mode DB (`packages/hub/src/test/helpers/drainApp.ts`, applied
  to 38 hub specs). `supertest(app)` leaves the Express app listening on an
  ephemeral port, so a response still draining could fail its write after
  `db.close()` and reset the socket, surfacing `read ECONNRESET` on whichever
  spec ran next. **Not a complete fix**: the same socket-reset flake still
  appears ~1 run in 5, now in
  `packages/server/src/test/item-reparent.test.ts`, a separate pre-existing
  issue in the server suite (it moves between files run-to-run and passes in
  isolation). Accepted as known flakiness.

## [1.1.17-beta.9] — 2026-09-03

### Added
- **PR Overview: selectable granularity** (CGLAB-133) — the "PR volume by
  size" chart can now be bucketed **daily / weekly (ISO, Mon–Sun) /
  monthly**, with **Total / Avg / Max** stats under the chart. Re-bucketed
  client-side from the API's existing per-UTC-day `byDay` array, so no API or
  SQL change and the counts stay identical to the heatmap and the per-cell
  drill-down. Week starts are UTC-anchored (a Sunday stays in the week that
  began Monday); `average` divides by every bucket in the range including
  empty ones, `max` names its bucket and breaks ties to the earliest.
  Tooltips carry the bucket's non-empty days, so a weekly/monthly bar drills
  back to the days it aggregates. New pure module `prVolumeGranularity.ts`
  (24 unit tests + mutation-sweep assertions).

### Testing
- **Full-suite wall clock: ~218s → ~58s** (3.7×) from the two changes below.
  Measured on the same machine, same 238 files / 2667 tests.
- **bcrypt cost is now configurable** via `AGENFK_HUB_BCRYPT_ROUNDS` (production
  default unchanged at 11, clamped to bcryptjs' valid 4..31, non-numeric falls
  back to the default). The vitest env pins it to 4: the hub suite performs
  ~238 **synchronous** bcrypt ops (114 user creations + 124 logins) which at
  rounds=11 cost ~23s of blocked worker per full run. The hash format is
  identical at cost 4, so signup/login/rotation paths stay exercised end to end
  — new `bcrypt-rounds.test.ts` pins the default, the clamping, lazy env reads,
  and that a reduced-cost hash still verifies.
- **Split vitest projects by filesystem coupling** (`vitest.config.ts`): the
  fs-free packages (core, hub-ui, ui, flow-editor, plus storage-sqlite/telemetry,
  which use per-file mkdtemp dirs or a mocked `os.homedir()`) now run their
  files concurrently in a `parallel` project, while server/hub/cli stay in a
  serial project. The previous blanket `fileParallelism: false` was serialising
  ~90 files that had nothing to contend over. Timeouts, aliases, the HOME pin
  and the coverage gate are shared from `scripts/vitest-shared-config.mjs` so
  the two projects cannot drift.
- **Hub test teardown now drains the ephemeral supertest listener** before
  closing the WAL-mode DB (`packages/hub/src/test/helpers/drainApp.ts`, applied
  to 38 hub specs). `supertest(app)` leaves the Express app listening on an
  ephemeral port, so a response still draining could fail its write after
  `db.close()` and reset the socket, surfacing `read ECONNRESET` on whichever
  spec ran next. **Not a complete fix**: the same socket-reset flake still
  appears ~1 run in 5, now in `packages/server/src/test/item-reparent.test.ts`,
  which is a separate pre-existing issue in the server suite (it moves between
  files run-to-run and passes in isolation). Accepted as known flakiness.

## [1.1.17-beta.8] — 2026-09-03

### Fixed
- **PR Overview drill-down modal** (CGLAB-131 follow-up, user-reported):
  - Size badges rendered as blank "white boxes" — `text-white` on the ramp's
    near-white light end (XS `#dbf7f0`, S `#7fe5ca`, M `#04cc98`). `SIZE_META`
    now carries a per-step label color: dark primary ink (`#000f3b`) on the
    light steps, white on the dark steps (L/XL). The badge is the only place
    text sits on the fill, so the change is scoped to it.
  - Rows with a derived GitHub link are now **whole-row links** (the `<a>` is
    the row container — no nested anchors), so repo / model / badge / time all
    open the PR; rows without a link stay inert.
  - New tests: pure `SIZE_META` text-contrast pin + jsdom page test covering
    the cell→modal flow, whole-row href without nested anchors, inert
    no-link rows, and badge contrast per ramp step.

## [1.1.17-beta.7] — 2026-09-03

### Added
- **PR Overview: per-cell drill-down** (CGLAB-131) — clicking a non-zero
  "Per developer, per day" heatmap cell opens a modal listing the PRs that
  developer opened that day (the same resolved PR set the heatmap counts —
  zero drift), with GitHub links where the hub could derive one
  (`prUrlFor`: github.com remotes only, documented slug fallback, no
  guessing for custom hosts). `/v1/prs/overview` now returns that per-PR
  list (`prs`), and the PR-event SELECT includes `remote_url`.
- Drill-down modal a11y: focus trap + initial focus + focus restore,
  body scroll lock, Esc/backdrop/× to close; non-zero cells are
  keyboard-operable (`role=button`, Enter/Space).
- **Coverage**: pg-mem e2e test for `/v1/prs/overview` (the jsonb sizing
  path through the dialect rewriter).

### Fixed
- **PR Overview tooltip placement / z-order** (CGLAB-131) — the tooltip
  rendered inside the `backdrop-blur` card section: its `backdrop-filter`
  became the containing block for the `position:fixed` element (re-rooting
  its coordinates — the "tooltip far away from the cell" defect) and a
  stacking context that swallowed the `z-50`. The tooltip now renders at
  the page root, with placement extracted to a pure, unit-tested
  `placeTooltip()` (viewport coordinates, edge clamping, flips below when
  there is no room above).

## [1.1.17-beta.6] — 2026-09-03

### Fixed
- Re-cut of the 1.1.17 beta line with **no code delta over beta.5** —
  cut to ship the pre-release flag fix below; superseded by beta.7
  (same line + the CGLAB-131 PR Overview work).
- GitHub releases for the 1.1.17 betas are now properly marked
  **pre-release** (beta.5/4/3 flagged retroactively); "Latest" points at
  the last stable release (v1.1.16).

## [1.1.17-beta.5] — 2026-09-02

### Fixed
- **Test runs can no longer touch the real `~/.agenfk`** (item 9c297075) — the
  structural fix for the 2026-08-31/09-01 hub.json clobber incidents:
  - Hub/telemetry home paths resolve at CALL time instead of import time
    (module-level `os.homedir()` captures are gone from telemetry, hub, and CLI
    rule-sync code), so per-test sandboxing always applies.
  - Every vitest worker (root + workspace + UI configs) starts with
    `process.env.HOME` pinned to a per-run sandbox; the real home is exposed as
    `AGENFK_REAL_HOME` for the tests that verify the pin.
  - New home-integrity sentinel (`scripts/home-integrity.mjs`) snapshots the
    protected `~/.agenfk` files before a test run and fails on any drift —
    wired into `test:home-integrity`, `test:coverage`, and the CI workflow
    (snapshot before, verify after the test step).
  - New `test:stryker` script runs Stryker under a spawn-time HOME pin
    (`scripts/stryker-home-wrap.mjs`) + sentinel: Stryker's forced threads pool
    keeps a frozen C environ where in-process env changes never reach
    `os.homedir()`, so the pin is baked into every spawned child instead — an
    unguarded launch now fails loudly via the `AGENFK_SPAWN_PIN` marker.
  - All remaining env-override test files (hub CLI, JIRA, migration, port
    discovery, hub-off/port-discovery routes) migrated to the `vi.mock('os')`
    homedir-mock pattern, verified green under `--pool threads`.

### Testing
- Diff-scoped StrykerJS pass (run through the guard): 76 mutants killed on the
  new code spans; remaining survivors are documented equivalents / per-test
  coverage attribution artifacts. Full suite 2601 tests across 235 files.

## [1.1.17-beta.4] — 2026-09-02

### Added
- **Hub admin → Models**: a model id is free text an installation self-reports via
  `--model <id>`, so one model reaching the hub as `qwen38-27b` and `qwen3.8:27b`
  appeared as two rows in the PR Overview "By model" table, splitting its PR count
  and offering two filter chips for one model. Admins can now map a reported
  spelling to a single desired name. Resolution is a read-time overlay
  (`model_mappings`), so `events` keeps recording what was actually reported and
  deleting a mapping puts the dashboards back — no recompute, no migration.
  Resolution is an exact lookup by deliberate choice: a normalization rule that
  maps `-` to `:` and `38` to `3.8` would silently merge genuinely different
  models. Saved links to an old spelling keep resolving, because filter values
  go through the same mapping as stored ones.

## [1.1.17-beta.3] — 2026-09-02

- **PR Overview dash: multi-select models filter** — the hub-ui PR Overview page's
  model filter is now a `FacetMultiselect` row (same component as Project/
  Developer); `?model=` is a CSV end-to-end (URL → toggle-set → data query →
  match-any on the PR *opener's* model), applied to both the current and
  previous-period windows so delta badges stay honest. Legacy single-value
  `?model=x` links keep working (`PrWindow.model` → `models: string[] | null`).
- **`parseList` hardening** — repeated query params (`?model=a&model=b`, which
  Express delivers as an array) are normalized to CSV form instead of 500-ing;
  covers every list filter (users/projects/types/itemTypes/model).
- **CLI test robustness** — hub deadletter list assertions are now
  color-independent (ANSI-tolerant), fixing a flake when the verify worker ran
  with `FORCE_COLOR`.
 origin/feat/CGLAB-117_hub-per-event-rejections

## [1.1.17-beta.2] — 2026-09-01

Hub org-boundary hardening (CGLAB-117) — after the 31 Aug 2026 incident, a clobbered
`~/.agenfk/hub.json` made one installation flush another org's queued events; the hub
rejected all 57 inside a `200 OK` and the flusher deleted them with the batch. This
release makes that failure mode structurally impossible and gives the operator the
tools to see and recover from it. See `HUB_ARCHITECTURE.md` §5.6.

### Added
- **Hub per-event rejection reasons**: `POST /v1/events` now answers
  `rejections: [{ eventId, reason }]` alongside the counters, with a four-code taxonomy
  (`invalid`, `org_mismatch`, `foreign_installation`, `hidden_user`).
- **Flusher org boundary**: only rows stamped for the installation's own org (or the
  pre-login `''` sentinel) ever enter a batch — enforced in SQL
  (`hubOutboxPeekDeliverable`), so stale rows never consume attempts and never starve
  the queue head. Surfaced as `staleOrgDepth` + per-org breakdown in
  `/internal/hub/status`, `agenfk hub status`, `agenfk hub flush`.
- **Deadletter instead of silent delete**: hub-refused events are preserved to
  `~/.agenfk/hub-deadletter.jsonl` *before* leaving the outbox; a failed write keeps
  the rows for retry. Against an old hub (no per-event detail) nothing is deleted at
  all — the batch is kept and re-sent idempotently with a loud `lastError`.
- **`agenfk hub carry-over --from <orgId> --to <orgId>`**: the sole path that rewrites
  an event's org stamp between named orgs — summary first, typed target confirmation
  (`--yes` for scripts, refusal on non-TTY), loud warning when the target is not the
  configured org, and every run audited to `~/.agenfk/hub-audit.jsonl`.
- **`agenfk hub deadletter`** (list, grouped by org) and
  **`agenfk hub deadletter discard --org X | --all`** (re-read before write, atomic
  replace, unparseable lines preserved on `--org`).
- **Identity gates**: `hub login` (both paths) and `hub join` refuse to persist a
  `hub.json` unless the URL about to be persisted answers `/healthz` with
  `service=agenfk-hub` — including the server-supplied `hubUrl` in device/redeem
  responses, and the invite is no longer POSTed to an ungated URL.
- **`hub repoint --carry-over`**: an org rename rewrites the outbox only when
  explicitly asked, through the same confirm + audit sequence; the default now prints
  the exact carry-over command and leaves the outbox untouched. The hub-ui rename
  campaign emits `--carry-over` (runners: add `--yes`).
- **Honest flush reporting**: `agenfk hub flush` exits 1 + red when the cycle ends
  with `lastError` — including a `200` that carried refusals — and prints yellow
  carry-over guidance when stale rows remain; `agenfk hub status` shows stale-org and
  deadletter depths.

### Fixed
- A `200 OK` containing per-event refusals no longer clears `lastError` — permanent
  loss no longer prints green.
- A no-op flush cycle (nothing deliverable) clears a historical `lastError`; `hub
  flush` no longer stays red forever after a transient failure once the outbox is
  empty.
- One corrupt outbox row (invalid JSON payload) could 500 the whole confirmed
  carry-over rewrite; the rewrite is now `json_valid`-guarded in SQL.
- `hub login` device flow: a refused/aborted config write no longer gets swallowed by
  the poll loop's error handling (endless polling instead of refusal).

## [1.1.0-beta.2] — 2026-06-23

### Changed
- **All skill flavors are now CLI-first**: the main `agenfk` skill and every sibling (`agenfk-code/close/test/review/deep/plan/pr/flow/calc-tokens`, plus `SKILL.md` and the per-client flavor files) now instruct the `agenfk` CLI directly instead of MCP-style function calls — each skill is self-contained (agents like Pi load each `~/.agents/skills/<name>/SKILL.md` independently). MCP tool names remain as optional "(MCP: …)" equivalents.
- Read commands in the skills and rule bundles use `--json` for machine-readable output.
- Removed the stale `log_token_usage` tool reference (token usage is ingested server-side).

### Fixed
- `bin/agenfk.js` refuses to run destructively from a source checkout (carried from beta.1; tightened guard).

## [1.1.0-beta.1] — 2026-06-23

### Changed
- **CLI-only by default**: AgEnFK no longer registers the MCP server with any client on install. The `agenfk` CLI is now the primary, fully server-enforced interface for the entire workflow. MCP becomes **opt-in**.
- **Upgrades flip cleanly to CLI-only**: a default (no `--with-mcp`) install/upgrade now *unregisters* any previously-registered agenfk MCP server across clients (claude/codex/gemini/cursor/opencode), so you don't end up in a half-state with stale MCP tools. Pass `--with-mcp` to keep/register it.
- Rule bundles (`CLAUDE.md`, `AGENTS.md`, `agenfk.mdc`, `GEMINI.md`) and `SKILL.md` rewritten to present the CLI as the default path, with a full CLI↔MCP command-mapping table; removed the prior "never use the CLI" guidance.

### Added
- **MCP opt-in flags**: `--with-mcp` registers the MCP server (e.g. `npx agenfk@latest --with-mcp`, `agenfk integration install <platform> --with-mcp`); `--no-mcp` force-disables it. The preference is persisted in `~/.agenfk/config.json` so re-installs honor it.
- **CLI parity commands** closing the former MCP-only gaps: `agenfk pause-work`, `resume-work`, `update-project`, `add-context`, `flow delete`, and `analyze`.
- **`--toon` global flag**: read commands (`list`, `get`, `list-projects`, `flow list`, `flow show`, `tokens`, `pr-register`, `pr-resize`, `update-project`) can emit compact **TOON** (Token-Oriented Object Notation) instead of JSON to reduce output tokens — tabular form for arrays of uniform objects.

### Platforms
- Claude Code: fully supported; gatekeeper + mcp-enforcer PreToolUse hooks still install (the enforcer permits the CLI when MCP is absent).
- Opencode / Gemini CLI / OpenAI Codex CLI / Cursor: CLI-driven workflow via the updated rule bundles; MCP available via `--with-mcp`.

## [0.2.1] — 2026-03-07

### Added
- **Custom Workflow Flows**: Projects can define custom multi-step flows with named steps and exit criteria (replaces fixed TODO → IN_PROGRESS → DONE).
- **Flow Designer**: Visual drag-and-drop flow editor in the Kanban UI.
- **TDD Flow**: Built-in TDD flow template (TODO → CREATE_UNIT_TESTS → IN_PROGRESS → REVIEW → DONE).
- **`get_flow` MCP tool**: Returns the active flow for a project including all steps and exit criteria.
- **`validate_progress` evidence param**: Mandatory `evidence` field logged as a tagged comment for audit trail.
- **Flow publish/install**: Share and install community workflow flows via a public registry repo.
- **Color-coded flow steps**: Steps and Kanban columns render with configurable accent colors.
- **Step colors in FlowStep type**: `color` field added to `FlowStep` in core and UI packages.

### Changed
- `review_changes` and `test_changes` MCP tools are now aliases of `validate_progress` (kept for backward compatibility).
- `validate_progress` on the final step enforces the project's `verifyCommand` automatically.
- Workflow gatekeeper now surfaces current step's exit criteria in the authorization response.

### Platforms
- Claude Code: fully supported via PreToolUse hooks.
- Opencode: fully supported via MCP + skill system.
- Google Gemini CLI: fully supported via MCP + workflow rules.
- OpenAI Codex CLI: fully supported via MCP + `AGENTS.md` rules.
- Cursor: experimental via `.mdc` instructional rules.

## [0.2.0] — 2026-03-01

### Added
- SQLite storage backend (`packages/storage-sqlite`) as an alternative to JSON.
- Telemetry package (`packages/telemetry`) for token usage tracking.
- `agenfk integration list/install/uninstall` commands for per-platform integration management.
- `agenfk health` command for system diagnostics.
- `agenfk upgrade --beta` flag for opting into pre-release versions.
- Parent–child status propagation: parent EPICs and STORYs auto-advance when all children advance.
- Sibling propagation: siblings on the same branch skip redundant build runs.

### Changed
- `agenfk up` now bootstraps services on first run if build artifacts are missing.
- MCP server now runs in stdio mode (`agenfk mcp`), compatible with all MCP clients.

## [0.1.x] — 2026-02-20 to 2026-02-28

Initial development: core monorepo setup, JSON storage, Express REST API, WebSocket real-time updates, React Kanban UI, CLI, MCP integration for Claude Code and Opencode, `validate_progress` workflow gate, auto git-commit on DONE.
