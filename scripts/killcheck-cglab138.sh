#!/bin/bash
# Apply one mutant at a time to flowRegistry.ts, run the service tests, and
# report KILLED / SURVIVED / NO-OP. Verifies the replacement is actually
# present in the LIVE file before trusting the verdict.
F=packages/hub/src/services/flowRegistry.ts
cp "$F" /tmp/fr.orig
TESTS="${TESTS:-packages/hub/src/test/flow-registry-service.test.ts}"

run() {
  local desc="$1" old="$2" new="$3"
  cp /tmp/fr.orig "$F"
  python3 - "$old" "$new" <<'PY'
import io, sys
p = 'packages/hub/src/services/flowRegistry.ts'
s = io.open(p, encoding='utf-8').read()
old, new = sys.argv[1], sys.argv[2]
if old not in s:
    raise SystemExit('PATTERN-NOT-FOUND')
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then echo "NO-OP     | $desc"; return; fi
  if ! grep -qF -- "$new" "$F"; then echo "NO-OP     | $desc (replacement absent)"; return; fi
  local out
  out=$(npx vitest run "$TESTS" 2>&1 | grep -E "^ +Tests " | tail -1)
  if echo "$out" | grep -q "failed"; then echo "KILLED    | $desc"
  elif echo "$out" | grep -q "passed"; then echo "SURVIVED  | $desc"
  else echo "NO-OP     | $desc (no test summary: $out)"; fi
}

run "L305 !resp.ok -> false" \
  'if (!resp.ok) { result.failed.push(file.name); continue; }' \
  'if (false) { result.failed.push(file.name); continue; }'
run "L305 push(file.name) -> push({})" \
  'if (!resp.ok) { result.failed.push(file.name); continue; }' \
  'if (!resp.ok) { result.failed.push({}); continue; }'
run "L305 drop continue" \
  'if (!resp.ok) { result.failed.push(file.name); continue; }' \
  'if (!resp.ok) { result.failed.push(file.name); }'
run "L233 existing.ok -> unconditional" \
  'if (existing.ok) sha = (await existing.json())?.sha;' \
  'sha = (await existing.json())?.sha;'
run "L233 ?.sha -> .sha" \
  'sha = (await existing.json())?.sha;' \
  'sha = (await existing.json()).sha;'
run "L155 ?.permissions?.push -> .permissions?.push" \
  'const canPush = meta?.permissions?.push;' \
  'const canPush = meta.permissions?.push;'
run "L206 flow?.name -> flow.name" \
  'name: flow?.name' \
  'name: flow.name'
run "L193 Array.isArray guard removed" \
  'Array.isArray(flow?.steps) ? flow.steps : []' \
  'flow?.steps'
run "L152 typeof meta guard removed" \
  "if (!meta || typeof meta !== 'object' || typeof meta.full_name !== 'string')" \
  "if (!meta || typeof meta.full_name !== 'string')"
run "L145 catch null -> undefined" \
  '.catch(() => null)' \
  '.catch(() => undefined)'
run "L135 e?.message -> e.message" \
  'could not reach GitHub: ${e?.message ?? e}' \
  'could not reach GitHub: ${e.message}'

cp /tmp/fr.orig "$F"
echo "--- source restored ---"
grep -n "if (!resp.ok) { result.failed" "$F"
