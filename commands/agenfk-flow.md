---
name: agenfk-flow
description: Interactively create or edit an AgenFK workflow flow in chat.
compatibility: all
metadata:
  framework: agenfk
  category: flow-management
---

# AgenFK Flow Manager

This skill guides you through creating or editing a custom workflow **flow** for an AgEnFK project.
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

Once confirmed, call the `create_flow` MCP tool:

```
create_flow(
  name: "<name>",
  description: "<description>",
  steps: [
    { name: "TODO",        label: "Not started",  order: 1, isAnchor: true },
    { name: "IN_PROGRESS", label: "In progress",  order: 2, exitCriteria: "..." },
    ...
    { name: "DONE",        label: "Done",         order: N, isAnchor: true },
  ],
  projectId: "<projectId>"   // optional — activates the flow immediately
)
```

If `projectId` is provided, the flow is created **and** activated for that project in one call.

**Fallback — CLI (if MCP is unavailable):**
```bash
agenfk flow create "<name>" --project "<projectId>"
```

### Step 6 — Optionally activate the flow for the project

If you did not pass `projectId` in Step 5, ask:
> "Would you like to activate this flow for project **[name]** now?"

If yes, call the `use_flow` MCP tool:

```
use_flow(projectId: "<projectId>", flowId: "<flowId>")
```

**Fallback — CLI:**
```bash
agenfk flow use <flowId> --project <projectId>
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

1. **List flows** — call `list_flows()` via MCP (or `agenfk flow list`).
2. **Show the target flow** — call `get_flow(projectId)` for the active flow, or inspect the full list.
3. **Update** — call `update_flow(id, name?, description?, steps?)` via MCP:

```
update_flow(
  id: "<flowId>",
  name: "New name",            // optional
  description: "New desc",     // optional
  steps: [ ... ]               // optional — replaces all steps
)
```

**Fallback — CLI:**
```bash
agenfk flow edit <id>
```

## Deleting a flow

Call `delete_flow(id)` via MCP, or `agenfk flow delete <id>`.

---

## Notes

- Flow names must be unique.
- `workflow_gatekeeper` returns the active flow's steps automatically — all platforms benefit once a flow is activated.
- To reset a project back to the default flow: `use_flow(projectId, "")` (empty flowId) or `agenfk flow reset --project <projectId>`.
- To share a flow with the community: `agenfk flow publish <flowId>`.
