#!/bin/bash
# Apply one mutant at a time to the flow-editor footer CTA logic, run the specs
# that exercise it, and report KILLED / SURVIVED / NO-OP. Same shape as
# killcheck-cglab138.sh, and for the same reason: Stryker's vitest runner cannot
# collect coverage from the jsdom component suite (it reported 0.14 tests per
# mutant and marked all 1109 FlowEditorModal.tsx mutants NoCoverage), so an
# automated mutation score for a .tsx component is not available here. Verifying
# the replacement landed in the LIVE file before trusting the verdict is the
# whole point — a mutant that was never applied reads exactly like a killed one.
#
# Each mutant below is a way the footer could quietly regress: a capability gate
# widened until it always renders, an ordering rule dropped so the bind races
# the save, a label falling back to the misleading default.
#
# LAST RUN: 21 killed, 3 survived, 0 no-op. All three survivors are recorded
# below with why they are not worth a test, in the same spirit as the "what the
# score does not say" section of HUB_ARCHITECTURE.md §6.1.1 — a survivor is only
# interesting if some input makes the mutant behave differently, and for these
# three none exists. Two are unreachable-by-construction guards kept as defence
# in depth; one is a genuinely equivalent null-coalescing swap.
#
# Do not run this concurrently with a build or test run: it rewrites the source
# files in place and restores them from a /tmp backup taken at start. A build
# that lands mid-mutate poisons that backup, and the poisoned copy then
# silently becomes the "restored" source.
F=packages/flow-editor/src/FlowEditorModal.tsx
R=packages/hub-ui/src/pages/adminFlowRegistry.ts
cp "$F" /tmp/fem.orig
cp "$R" /tmp/afr.orig
TESTS="packages/ui/src/test/FlowEditorModal.test.tsx packages/hub-ui/src/test/adminFlowsEditor.test.tsx packages/hub-ui/src/test/adminFlowRegistry.test.ts"

run() {
  local desc="$1" file="$2" old="$3" new="$4"
  cp /tmp/fem.orig packages/flow-editor/src/FlowEditorModal.tsx
  cp /tmp/afr.orig packages/hub-ui/src/pages/adminFlowRegistry.ts
  python3 - "$file" "$old" "$new" <<'PY'
import io, sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
if old not in s:
    raise SystemExit('PATTERN-NOT-FOUND')
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then echo "NO-OP     | $desc"; return; fi
  if ! grep -qF -- "$new" "$file"; then echo "NO-OP     | $desc (replacement absent)"; return; fi
  local out
  out=$(npx vitest run --config vitest.footerctas.config.ts $TESTS 2>&1 | grep -E "^ +Tests " | tail -1)
  if echo "$out" | grep -q "failed"; then echo "KILLED    | $desc"
  elif echo "$out" | grep -q "passed"; then echo "SURVIVED  | $desc"
  else echo "NO-OP     | $desc (no test summary: $out)"; fi
}

# ── Publish capability gate (item 1) ────────────────────────────────────────
run "canPublish: typeof check -> always true" "$F" \
  'const canPublish = typeof registryClient.publishToRegistry === '"'"'function'"'"';' \
  'const canPublish = true;'

run "canPublish: typeof check -> always false" "$F" \
  'const canPublish = typeof registryClient.publishToRegistry === '"'"'function'"'"';' \
  'const canPublish = false;'

# SURVIVED, deliberately kept. The button is gated on the same `canPublish`, so
# no UI path reaches this throw: the mutant is unreachable-by-construction, and
# killing it would mean calling the mutation from outside the component, which
# asserts on internals rather than behaviour. The guard stays as defence in
# depth — if a future host renders the button off a different flag, the failure
# is a legible error instead of a `publishToRegistry is not a function` TypeError.
run "publish guard: !canPublish throw removed" "$F" \
  "if (!canPublish) throw new Error('This host cannot publish flows.');" \
  "if (false) throw new Error('This host cannot publish flows.');"

# ── Bind saves before it binds (item 3) ─────────────────────────────────────
run "bind: isDirty save-first -> bind the stale id" "$F" \
  '      const current = isDirty ? await persist() : (flow as Flow);
      await flowClient.setProjectFlow(projectId, current.id);
      return current;' \
  '      await flowClient.setProjectFlow(projectId, flow!.id);
      return flow as Flow;'

run "bind: always re-save, even when clean" "$F" \
  '      const current = isDirty ? await persist() : (flow as Flow);' \
  '      const current = await persist();'

run "bind: bind BEFORE the save resolves (the original race)" "$F" \
  '      const current = isDirty ? await persist() : (flow as Flow);
      await flowClient.setProjectFlow(projectId, current.id);
      return current;' \
  '      const current = isDirty ? await persist() : (flow as Flow);
      void flowClient.setProjectFlow(projectId, (flow as Flow).id);
      return current;'

run "bind: move the bind back into onSuccess (unmount loses it)" "$F" \
  '      const current = isDirty ? await persist() : (flow as Flow);
      await flowClient.setProjectFlow(projectId, current.id);
      return current;' \
  '      const current = isDirty ? await persist() : (flow as Flow);
      return current;'

# ── Publish saves before it publishes (item 4 support) ──────────────────────
run "publish: dirty/new save-first -> publish whatever id is on hand" "$F" \
  '      if (isDirty || !id) {
        const saved = await persist();
        rebaseOn(saved);
        id = saved?.id;
      }' \
  '      if (false) {
        const saved = await persist();
        rebaseOn(saved);
        id = saved?.id;
      }'

run "publish: only the missing-id case saves (dirty edits are dropped)" "$F" \
  '      if (isDirty || !id) {' \
  '      if (!id) {'

# ── Dirty tracking (what makes the ordering rule decidable) ─────────────────
run "isDirty: no-baseline case treated as clean" "$F" \
  'const isDirty = persisted === null || serializeDefinition(name, description, steps) !== persisted;' \
  'const isDirty = persisted !== null && serializeDefinition(name, description, steps) !== persisted;'

run "isDirty: comparison inverted" "$F" \
  'serializeDefinition(name, description, steps) !== persisted;' \
  'serializeDefinition(name, description, steps) === persisted;'

run "isDirty: always dirty" "$F" \
  'const isDirty = persisted === null || serializeDefinition(name, description, steps) !== persisted;' \
  'const isDirty = true;'

run "isDirty: never dirty" "$F" \
  'const isDirty = persisted === null || serializeDefinition(name, description, steps) !== persisted;' \
  'const isDirty = false;'

# ── Re-baseline on the SERVER response ──────────────────────────────────────
# SURVIVED, deliberately kept. `persist()` types its result `Flow` and both
# servers answer 201/200 with the stored row, so no caller can hand this a
# null/undefined; the guard is a null-safety belt. The mutant replaces it with
# a truthiness no-op, which is behaviourally identical for every reachable
# input.
run "rebaseOn: null-response guard removed" "$F" \
  '    if (!savedFlow) return;' \
  '    if (savedFlow) { void 0; }'

run "rebaseOn: never re-baseline" "$F" \
  '    setPersisted(serializeDefinition(
      savedFlow.name,
      savedFlow.description ?? '"'"''"'"',
      [...(savedFlow.steps ?? [])].sort((a, b) => a.order - b.order),
    ));' \
  '    void savedFlow;'

# ── Single footer, gated per capability (item 4) ────────────────────────────
run "canSave: read-only gate removed" "$F" \
  'const canSave = !isReadOnly;' \
  'const canSave = true;'

run "footer: publish button gated back on flow?.id" "$F" \
  '            {canPublish && (
              <button
                data-testid="publish-flow-btn"' \
  '            {canPublish && flow?.id && (
              <button
                data-testid="publish-flow-btn"'

run "footer: use-flow button gated back on !isReadOnly" "$F" \
  '            {canSelectFlow && !isReadOnly && (' \
  '            {canSelectFlow && ('

# ── Labels reach the button (item 2) ────────────────────────────────────────
run "labels: save caption ignores the host" "$F" \
  "save: labels?.save?.trim() || DEFAULT_EDITOR_LABELS.save," \
  'save: DEFAULT_EDITOR_LABELS.save,'

run "labels: useFlow caption ignores the host" "$F" \
  "useFlow: labels?.useFlow?.trim() || DEFAULT_EDITOR_LABELS.useFlow," \
  'useFlow: DEFAULT_EDITOR_LABELS.useFlow,'

# SURVIVED — genuinely equivalent. `labels?.save ?? DEFAULT` differs from
# `labels?.save?.trim() || DEFAULT` only for a host that passes a whitespace-only
# caption, and `??` would then render a blank button. No host does that, and the
# trim-then-fall-back form is the one that cannot produce an invisible label, so
# it is kept on purpose. Killing it would mean asserting that the editor renders
# a whitespace caption as whitespace.
run "labels: empty-string host label not replaced by default" "$F" \
  "save: labels?.save?.trim() || DEFAULT_EDITOR_LABELS.save," \
  'save: labels?.save ?? DEFAULT_EDITOR_LABELS.save,'

# ── The "Saved" badge survives the save ─────────────────────────────────────
run "badge: confirmation falls back to the editor default, ignoring the host" "$F" \
  "saved && !isDirty ? labels.saved : labels.save}" \
  'saved && !isDirty ? DEFAULT_EDITOR_LABELS.saved : labels.save}'

# ── Publish is blocked for the same reason Save is ───────────────────────────
run "publish button ignores the blocked-definition state" "$F" \
  'disabled={publishMutation.isPending || isSaveDisabled}' \
  'disabled={publishMutation.isPending}'

run "registryConfigSaveLabel: plain case collapses onto Save" "$R" \
  "return base === 'Save' ? 'Save registry repo' : base;" \
  'return base;'

cp /tmp/fem.orig packages/flow-editor/src/FlowEditorModal.tsx
cp /tmp/afr.orig packages/hub-ui/src/pages/adminFlowRegistry.ts
echo "--- sources restored ---"
grep -c "canPublish" packages/flow-editor/src/FlowEditorModal.tsx
grep -c "registryConfigSaveLabel" packages/hub-ui/src/pages/adminFlowRegistry.ts
