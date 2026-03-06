# AgenFK Flow Manager

This instruction guides you through creating or editing a custom workflow **flow** for an AgenFK project.
A flow defines the ordered steps (statuses) that items move through — replacing the default
TODO → IN_PROGRESS → REVIEW → TEST → DONE pipeline with a tailored one for your team.

## Activation

Begin this flow when the user says:
- "Help me create a new flow"
- "I want to set up a custom workflow"
- "Create a flow for [description]"
- `/agenfk-flow`

---

## Conversation Protocol

Follow these steps in order. Ask one section at a time.

> **Codex note**: Codex does not support PreToolUse hooks. Follow all instructions strictly.

### Step 1 — Identify the project

1. Check for `.agenfk/project.json` in the working directory to get the `projectId`.
2. If not found, run `agenfk list-projects --json` and ask the user which project.
3. Confirm: "I'll create this flow for project **[name]** (`[projectId]`). Is that correct?"

### Step 2 — Flow identity

Ask:
- **Flow name** (required, machine-safe, e.g. `security-review`, `ml-training`): no spaces, lowercase-hyphenated recommended.
- **Description** (optional): one sentence describing when to use this flow.

### Step 3 — Collect steps

Explain:
> "A flow is a sequence of steps. Each step represents a status an item can be in.
> You need at least 2 steps. The last step is usually a terminal step (equivalent to DONE).
> Tell me about each step one at a time, or give me the full list at once."

For each step, collect:
| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Machine-safe identifier, e.g. `IN_PROGRESS`, `QA`, `SHIPPED` |
| `label` | No | Human-friendly display name (defaults to `name`) |
| `exitCriteria` | No | What must be true before leaving this step |
| `isSpecial` | No | `true` if this is a terminal/archive step (like DONE) |

Steps are automatically ordered in the sequence you provide them.

Example for a security-focused flow:
1. `TODO` — "Not started"
2. `IN_PROGRESS` — "Being implemented"
3. `SEC_REVIEW` — exitCriteria: "No critical CVEs, signed off by security team"
4. `STAGING` — exitCriteria: "All integration tests pass on staging"
5. `DONE` — isSpecial: true

### Step 4 — Preview and confirm

Show the flow as a table and ask: "Does this look right? (yes / edit / cancel)"

### Step 5 — Create the flow

Once confirmed:

```bash
curl -s -X POST http://localhost:3000/flows \
  -H "Content-Type: application/json" \
  -d '{"name":"<name>","description":"<desc>","projectId":"<id>","steps":[...]}'
```

Or via CLI (interactive):
```bash
agenfk flow create "<name>" --project "<projectId>"
```

### Step 6 — Optionally activate the flow

Ask: "Would you like to activate this flow for the project now?"

If yes:
```bash
agenfk flow use <flowId> --project <projectId>
```

### Step 7 — Summary

Report:
- Flow ID and name
- Number of steps
- Activation status
- `agenfk flow show <flowId>` to inspect

---

## Editing an existing flow

1. `agenfk flow list`
2. `agenfk flow show <id>`
3. `agenfk flow edit <id>`

---

## Notes

- Once activated, `workflow_gatekeeper` returns the active flow's steps automatically.
- Reset to default: `agenfk flow reset --project <projectId>`
- Share: `agenfk flow publish <flowId>`
