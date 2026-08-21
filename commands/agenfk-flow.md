---
name: agenfk-flow
description: Interactively create or edit an AgenFK workflow flow in chat.
compatibility: all
metadata:
  framework: agenfk
  category: flow-management
---

# AgenFK Flow Manager

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

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

1. Run `agenfk current-project` to get the `projectId` (it resolves the nearest `.agenfk/project.json`, walking up from the cwd).
2. If not found, run `agenfk list-projects --json` (MCP: `list_projects`) and ask the user which project to scope the flow to.
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

Once confirmed, run `agenfk flow create "<name>"` (MCP: `create_flow`). The CLI gathers the description and steps interactively, then prints the new flow's ID. (Activate it for a project in Step 6.)

```bash
agenfk flow create "<name>"
```

The equivalent MCP call accepts the full step list and an optional `projectId` to create-and-activate in one call:

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

### Step 6 — Activate the flow for the project

Ask:
> "Would you like to activate this flow for project **[name]** now?"

If yes, run `agenfk flow use <flowId> --project <projectId>` (MCP: `use_flow`):

```bash
agenfk flow use <flowId> --project <projectId>
```

### Step 7 — Summary

Report back:
- Flow ID and name
- Number of steps created
- Whether it was activated for the project
- CLI command to inspect it: `agenfk flow show <flowId> --json`

---

## Editing an existing flow

If the user wants to edit a flow instead of creating one:

1. **List flows** — run `agenfk flow list --json` (MCP: `list_flows`).
2. **Show the target flow** — run `agenfk flow show --project <projectId> --json` for the active flow (MCP: `get_flow`), or inspect the full list.
3. **Update** — run `agenfk flow edit <id>` (MCP: `update_flow`):

```bash
agenfk flow edit <id>
```

The equivalent MCP call accepts the full step list:

```
update_flow(
  id: "<flowId>",
  name: "New name",            // optional
  description: "New desc",     // optional
  steps: [ ... ]               // optional — replaces all steps
)
```

## Deleting a flow

Run `agenfk flow delete <id>` (MCP: `delete_flow`).

---

## Notes

- Flow names must be unique.
- the `workflow_gatekeeper` MCP tool returns the active flow's steps automatically (the CLI reports only the current step, so read the flow with `agenfk flow show`) — all platforms benefit once a flow is activated.
- To reset a project back to the default flow: `agenfk flow use "" --project <projectId>` (empty flowId) or `agenfk flow reset --project <projectId>`.
- To share a flow with the community: `agenfk flow publish <flowId>`.
