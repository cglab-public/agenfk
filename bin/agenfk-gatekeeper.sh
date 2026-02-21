#!/bin/bash
# AgenFK Workflow Gatekeeper — Claude Code PreToolUse Hook
#
# Installed to ~/.local/bin/agenfk-gatekeeper by install.sh
# Configured as a PreToolUse hook in ~/.claude/settings.json
#
# Blocks Edit/Write/NotebookEdit tools if no AgenFK task is IN_PROGRESS.
# Exits silently (0) if the API server is not running, so offline work
# is never hard-blocked.

API_URL="${AGENFK_API_URL:-http://127.0.0.1:3000}"

# Consume stdin — Claude Code pipes tool JSON here; drain it to avoid broken pipe
INPUT=$(cat)

# Query the API for IN_PROGRESS items (2s timeout)
RESPONSE=$(curl -sf --max-time 2 "${API_URL}/items?status=IN_PROGRESS" 2>/dev/null)
if [ $? -ne 0 ]; then
    # API not reachable — skip enforcement gracefully
    exit 0
fi

# Count items via node (Node.js is a hard requirement of agenfk)
COUNT=$(printf '%s' "$RESPONSE" | node -e \
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch(e){console.log(0)}})" \
    2>/dev/null || echo "0")

if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
    printf '{"decision":"block","reason":"AgenFK WORKFLOW VIOLATION: No task is IN_PROGRESS.\n\nBefore modifying files you must:\n  1. Create a task:  agenfk create task \"<title>\"\n  2. Start it:       agenfk update <id> --status IN_PROGRESS\n\nThen retry your change."}'
    exit 0
fi

exit 0
