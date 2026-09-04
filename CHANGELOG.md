# Changelog

All notable changes to AgEnFK are documented here.

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
