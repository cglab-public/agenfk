---
name: agenfk-flow
description: Interactively create or edit an AgenFK workflow flow in chat.
compatibility: claude-code
metadata:
  framework: agenfk
  category: flow-management
---

# AgenFK Flow Manager

This skill guides you through creating or editing a custom workflow **flow** for an AgenFK project.
A flow defines the ordered steps (statuses) that items move through — replacing the default
TODO → IN_PROGRESS → REVIEW → TEST → DONE pipeline with a tailored one for your team.

## How to use this skill

Invoke this skill by running the `/agenfk-flow` slash command or by asking:
> "Help me create a new flow" / "I want to set up a custom workflow"

---

## Conversation Protocol

Follow these steps in order. Ask one section at a time — do not dump all questions at once.

### Step 1 — Identify the project

1. Check for `.agenfk/project.json` in the working directory to get the `projectId`.
2. If not found, call `list_projects()` via MCP and ask the user which project to scope the flow to.
3. Confirm: "I'll create this flow for project **[name]** (`[projectId]`). Is that correct?"

### Step 2 — Flow identity

Ask:
- **Flow name** (required, machine-safe, e.g. `security-review`, `ml-training`): no spaces, lowercase-hyphenated recommended.
- **Description** (optional): one sentence describing when to use this flow.

### Step 3 — Collect steps

Explain to the user:
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

Example steps for a security-focused flow:
1. `TODO` — "Not started"
2. `IN_PROGRESS` — "Being implemented"
3. `SEC_REVIEW` — "Security review", exitCriteria: "No critical CVEs, signed off by security team"
4. `STAGING` — "Deployed to staging", exitCriteria: "All integration tests pass on staging"
5. `DONE` — "Released", isSpecial: true

### Step 4 — Preview and confirm

Display the collected flow as a table:

```
Flow: [name]
Description: [description]

Order | Name         | Label            | Exit Criteria                    | Terminal?
------|--------------|------------------|----------------------------------|----------
1     | TODO         | Not started      |                                  | No
2     | IN_PROGRESS  | In progress      |                                  | No
...
```

Ask: "Does this look right? Type **yes** to create, **edit** to change a step, or **cancel** to abort."

### Step 5 — Create the flow

Once confirmed, run via Bash:

```bash
agenfk flow create "[name]" --project "[projectId]"
```

The CLI will interactively prompt for description and steps. However, since you have already
collected all the data, use the **server API directly** via MCP if available, or construct
the CLI call non-interactively using the `agenfk flow create` command.

**Option A — MCP server API (preferred when MCP is available):**

Call `POST /flows` via the agenfk MCP server:
```json
{
  "name": "<name>",
  "description": "<description>",
  "projectId": "<projectId>",
  "steps": [
    { "name": "TODO", "label": "Not started", "order": 1, "isSpecial": false },
    { "name": "IN_PROGRESS", "label": "In progress", "order": 2, "isSpecial": false },
    ...
  ]
}
```

Since there is no direct `create_flow` MCP tool, use Bash to call the server REST API:
```bash
curl -s -X POST http://localhost:3000/flows \
  -H "Content-Type: application/json" \
  -d '{"name":"<name>","description":"<desc>","projectId":"<id>","steps":[...]}'
```

**Option B — CLI (fallback):**
```bash
agenfk flow create "<name>" --project "<projectId>"
```
Then enter each step when prompted.

### Step 6 — Optionally activate the flow for the project

After creation, ask:
> "Would you like to activate this flow for project **[name]** now?"

If yes, run:
```bash
agenfk flow use <flowId> --project <projectId>
```

Or via REST:
```bash
curl -s -X POST http://localhost:3000/projects/<projectId>/flow \
  -H "Content-Type: application/json" \
  -d '{"flowId":"<flowId>"}'
```

### Step 7 — Summary

Report back:
- Flow ID and name
- Number of steps created
- Whether it was activated for the project
- CLI command to inspect it: `agenfk flow show <flowId>`

---

## Editing an existing flow

If the user wants to edit a flow instead of creating one:

1. List flows: `agenfk flow list` or `GET /flows`
2. Show the target flow: `agenfk flow show <id>`
3. Run: `agenfk flow edit <id>` — or use `PUT /flows/<id>` via REST with the full updated flow body.
4. Confirm changes.

---

## Notes

- Flow names must be unique within a project.
- The `workflow_gatekeeper` MCP tool returns the active flow's steps — all platforms benefit automatically once a flow is activated.
- To reset a project back to the default flow: `agenfk flow reset --project <projectId>`
- To share a flow with the community: `agenfk flow publish <flowId>`
