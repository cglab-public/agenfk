

Now the spoke side and other consumers:




Now let me verify the HubEvent type, find all consumers of the endpoint, and check the server's body-limit/error handling:





HubEvent.eventId is a required `string`, so post-narrowing access is safe. Next, check whether the existing hub tests are strictly pinning the shape of the response (the new field could break that), and check the git log for this change:




All 8 new tests pass. Let me run the neighboring suites that exercise the same handler, and typecheck:




Typecheck is clean and all 45 neighboring tests pass. Final checks — docs that describe the response shape, and the 413/400 shape pinning in existing tests:




# Adversarial review: CGLAB-117 — per-event rejection reasons in `/v1/events`

## (1) Findings

### F1 — minor, CONFIRMED — `packages/hub/src/routes/events.ts:252-259` (400/413 early returns)
**The 400/413 paths omit `rejections`, and nothing pins that.** I judge the omission **correct**: on 413 the batch is *unprocessed* and can contain >500 events (the cap fires before the loop, events.ts:257-259), so emitting `rejections` there would be unbounded and would reopen the response-size DoS the cap (bug 035a4736) exists to close; on 400 there are no events to report. The flusher treats any 4xx as non-destructive (no outbox delete, backoff/halt — `flusher.ts:271-309`), so no data loss depends on the field's presence. But the *absence* is a deliberate API decision with a DoS rationale and currently only the 413 status + "nothing written" is pinned (`security-hardening.test.ts:107-117` asserts status and DB count, not body shape). A future "consistency" fix adding `rejections` to 413 would silently reintroduce the unbounded-response path.
**Fix:** one test: `post([])` → 400 and `post(501 events)` → 413, both asserting `expect(r.body.rejections).toBeUndefined()`.

### F2 — minor, CONFIRMED — `packages/hub/src/test/events-rejections.test.ts:177`
**Entry ordering is unpinned.** The mixed-batch test sorts `rejections` by eventId before comparing, so the contract "entries appended in batch order" (stated in the test's own comment) is not pinned. If the follow-up flusher deadletter (keyed by eventId) or a hub UI ever relies on order, it has no regression net.
**Fix:** drop the `.sort(...)` in that one assertion (the expected array is already in batch order: e-bad-1, e-foreign-1, e-hidden-1, e-org-1), or add a dedicated ordering test.

### F3 — minor, CONFIRMED — `packages/hub/src/routes/events.ts:400-402`
**A duplicate `eventId` in a batch is `skipped` (INSERT OR IGNORE, `result.changes === 0`), not rejected — so it appears in *neither* `rejections` nor `rejected`.** For the stated purpose ("which events were lost"), a duplicate that got deduped is an invisible loss in the new payload too, and no test pins this branch (the mixed test's `e-skip-1` exercises the `tokens.logged` skip, not the dedup skip). The follow-up deadletter story keyed by eventId needs to know duplicate copies are *not* reportable losses.
**Fix:** add a test: batch with the same valid eventId twice → `ingested: 1, skipped: 1, rejections: []` — pinning that dedup is not a rejection.

### F4 — nit, CONFIRMED — `packages/hub/src/routes/events.ts:194-195`
**No test for degenerate array elements** (`null`, `42`, `"str"`, `[]` in `events`). I traced each: `isValidEvent` → false, `eventIdOf` → `null` (primitives/arrays have no string `eventId`), so each yields `{eventId: null, reason: 'invalid'}` and increments `rejected`. Handled correctly; same code path as the tested missing-eventId case. Optional one-liner test if you want the boundary pinned.

## (2) Checked and clean

- **Authz/tenancy unchanged.** The diff only adds `rejections.push(...)` after the existing `rejected++`/`hiddenDropped++` in each branch — conditions, order, and `continue`s are byte-identical in logic (diff lines 284-293). The CGLAB-75/76 adoption path, foreign-install snapshot, hidden/alias loads, and all SQL are untouched. Confirmed against the full file, not just the diff.
- **No new information leak via `rejections`.** Every entry's `eventId` is a value the *caller* put in *their own* request; no other tenant's data is read into the response. Reason codes traced for the cross-org attacker case (org-B key posting org-A-stamped events): `org_mismatch` is identical whether the claimed org exists on the hub or not (the old `rejected` counter was equally uninformative); `foreign_installation` merely names a distinction already observable before the change (naming an unregistered installation id was *ingested* — upsert creates the row in the caller's own org — vs a foreign id which was *rejected*, so "does this id exist in another org's fleet" was already discriminable via the counters); `hidden_user` is unreachable on cross-org stamps (the org check fires first and `hidden_users` is loaded only for the token's org), and the user key is derived from caller-controlled `actor` fields — so no probe of another org's hidden list is possible. `invalid` is pure caller input.
- **TS narrowing / edge cases.** `HubEvent.eventId` is a required `string` (`packages/core/src/interfaces.ts:141`), so `e.eventId` in the narrowed branches is always a usable string; `eventIdOf` correctly nulls out missing/empty/non-string eventIds, including after `isValidEvent` fails on shape (e.g. `actor: null`). Empty-string boundary pinned by test 2. `npx tsc --noEmit` in `packages/hub`: exit 0.
- **Batch ceiling / response size.** 413 fires before `rejections` is built; worst case is 500 entries whose total size is bounded by the sum of the caller's own eventIds inside the 10 MB body limit (`server.ts:180`) — no amplification, and ingested events already store the full `JSON.stringify(e)` anyway.
- **Concurrency/async.** `rejections` is a handler-local `const` (per-request closure); no module/ctx-level state introduced; transaction boundary unchanged; on transaction throw the handler 500s with no response and the flusher retries (safe: rollback + INSERT OR IGNORE replay idempotency — pre-existing).
- **Backward compatibility.** The only consumer in the repo is `packages/server/src/hub/flusher.ts`: `isHubEventsAck` (line 64) requires `ingested` to be a number — still present; the refusal count reads `rejected` (line 250) — unchanged; outbox delete on 200 unchanged. Old spokes ignore the additive field. Grep confirmed no other consumer parses the body (CLI/admin/other hub files only reference the word "ingested" in comments). Existing hub tests use `objectContaining`/field access (events.test.ts:74,97), so the added field breaks nothing.
- **Tests pass.** New file: 8/8. Neighboring suites (events, events-hidden-users, security-hardening, hub-tenant-isolation): 45/45.
- **Design decisions (a)–(e) all hold.** (a) BOLA + cross-org both → `foreign_installation` (lines 287-288); (b) best-effort eventId with the empty-string boundary (lines 194-195, pinned); (c) `hidden_user` in both `hiddenDropped` and `rejections` (line 293, pinned by test 6 which asserts `rejected: 0`); (d) first-failing-check-wins — every branch pushes exactly once and `continue`s; `skipped` branches push nothing; (e) bounded by the pre-existing 500 cap.

## (3) Verdict

Clean, security-neutral, backward-compatible additive change — ship it; the only gaps are three minor test-pins (413/400 body shape, entry order, dedup-skip semantics) that matter mainly as regression nets for the follow-up deadletter story.

*(Note: the GitHub-admin golden-path reminder doesn't apply here — this is a code review, not repo administration.)*