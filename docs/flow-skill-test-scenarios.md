# AgenFK Flow Skill — End-to-End Test Scenarios

This document describes end-to-end test scenarios for chat-based flow creation and editing
using the `agenfk-flow` skill on each supported platform.

Each scenario includes:
- The trigger / invocation method
- The expected conversation flow (user prompts and agent responses)
- The expected system outcomes (files created, API calls made, flow activated)
- Edge cases and failure modes

---

## Platform: Claude Code

**Skill location**: `~/.claude/skills/agenfk-flow/SKILL.md`
**Invocation**: `/agenfk-flow` slash command or natural language ("Help me create a new flow")

---

### Scenario CC-1: Create a basic security-review flow

**Setup**: User is in a project directory with `.agenfk/project.json` present.

**Conversation**:

```
User: /agenfk-flow

Agent: I'll help you create a new AgenFK workflow flow.
       I found your project: "AgenFK Framework" (duaa8dto2g6wdyc75bvbuh).
       Is that the project you'd like this flow for?

User: Yes

Agent: Great! What would you like to name this flow?
       (Use a machine-safe name like `security-review` or `ml-pipeline` — no spaces)

User: security-review

Agent: Got it. Would you like to add a description? (optional)

User: For features that require security sign-off before release

Agent: Perfect. Now let's add the steps for this flow.
       Tell me about each step one at a time, starting with the first one.
       What's the name of step 1?

User: TODO

Agent: Display label for TODO? (press Enter to use "TODO")

User: [Enter]

Agent: Exit criteria for TODO? (optional, press Enter to skip)

User: [Enter]

Agent: Is TODO a terminal/archive step? (yes/no)

User: no

Agent: Step 2 name? (or leave blank to finish)

User: IN_PROGRESS

Agent: [collects label, exit criteria, isSpecial for IN_PROGRESS...]

User: [similar for SEC_REVIEW with exitCriteria: "No critical CVEs, security team sign-off"]
User: [similar for STAGING with exitCriteria: "Integration tests pass"]
User: [DONE with isSpecial: true]
User: [blank — finish]

Agent: Here is your flow:

       Flow: security-review
       Description: For features that require security sign-off before release

       Order | Name        | Label           | Exit Criteria                      | Terminal?
       ------|-------------|-----------------|----------------------------------  |----------
       1     | TODO        | TODO            |                                    | No
       2     | IN_PROGRESS | In Progress     |                                    | No
       3     | SEC_REVIEW  | Security Review | No critical CVEs, sec team sign-off| No
       4     | STAGING     | Staging         | Integration tests pass             | No
       5     | DONE        | Done            |                                    | Yes

       Does this look right? (yes / edit / cancel)

User: yes

Agent: [Runs: curl -X POST http://localhost:3000/flows -d '{"name":"security-review",...}']

       Flow created successfully!
       ID: abc123
       Name: security-review
       Steps: 5

       Would you like to activate this flow for project "AgenFK Framework" now?

User: yes

Agent: [Runs: agenfk flow use abc123 --project duaa8dto2g6wdyc75bvbuh]

       Done! The "security-review" flow is now active for this project.
       Inspect it anytime with: agenfk flow show abc123
```

**Expected outcomes**:
- `POST /flows` called with correct body
- `POST /projects/:id/flow` called with `{"flowId": "abc123"}`
- `agenfk flow show abc123` displays all 5 steps in order
- `workflow_gatekeeper` response now includes `activeFlow.steps` with the 5 custom steps

---

### Scenario CC-2: Project not detected — multi-project selection

**Setup**: No `.agenfk/project.json` in the working directory.

**Conversation**:

```
User: Help me create a new flow

Agent: I'll help you set up a custom workflow flow.
       I couldn't find a .agenfk/project.json in the current directory.
       [Calls list_projects() via MCP]
       I found 3 projects:
         1. AgenFK Framework (duaa8dto2g6wdyc75bvbuh)
         2. My Web App (abc456)
         3. Data Pipeline (xyz789)
       Which project should this flow be scoped to?

User: 2

Agent: Using project "My Web App" (abc456).
       [Continues with flow name collection...]
```

**Expected outcomes**: Correct `projectId` used in `POST /flows` body.

---

### Scenario CC-3: Edit flow request

**Conversation**:

```
User: I want to edit the security-review flow

Agent: [Runs: agenfk flow list]
       Found flows:
         - security-review (abc123) — 5 steps
         - default (def456) — 5 steps

       Showing security-review:
       [Displays current steps]

       Which step would you like to edit, or would you like to add/remove steps?

User: Change SEC_REVIEW exit criteria to "No high/critical CVEs, pen-test passed"

Agent: [Runs: PUT /flows/abc123 with updated step]
       Updated! Exit criteria for SEC_REVIEW is now: "No high/critical CVEs, pen-test passed"
```

---

### Scenario CC-4: Cancel during creation

**Conversation**:

```
User: /agenfk-flow
[... agent collects flow details ...]

Agent: Here is your flow: [table]
       Does this look right? (yes / edit / cancel)

User: cancel

Agent: Flow creation cancelled. No changes were made.
```

**Expected outcome**: No `POST /flows` call made.

---

## Platform: OpenCode

**Skill location**: `~/.config/opencode/skills/agenfk-flow/SKILL.md`
**Invocation**: `/agenfk-flow` or natural language. Uses Question UI (`default_api:question`).

---

### Scenario OC-1: Create flow with Question UI

**Setup**: Project linked. OpenCode detects `.agenfk/project.json`.

**Conversation** (Question UI dialogs shown as `[Q]`):

```
User: /agenfk-flow

Agent: Starting AgenFK Flow Manager.
       Project: "AgenFK Framework" (duaa8dto2g6wdyc75bvbuh). Correct?

[Q] "Is this the right project? (yes/no)"
User answers: yes

[Q] "Flow name (machine-safe, e.g. ml-pipeline):"
User answers: ml-training

[Q] "Description (optional):"
User answers: ML model training and evaluation pipeline

[Q] "Step 1 name (or blank to finish):"
User answers: DATA_PREP

[Q] "Display label for DATA_PREP:"
User answers: Data Preparation

[Q] "Exit criteria (optional):"
User answers: Training dataset validated, >10k samples

[Q] "Is this a terminal step? (yes/no):"
User answers: no

[Q] "Step 2 name:"
User answers: TRAINING

... [continues for EVAL, DEPLOY, DONE] ...

[Q] "Step 5 name (blank to finish):"
User answers: [blank]

Agent: [Displays table — Opencode shows all MCP call parameters]
       MCP call: POST /flows
       Body: {"name":"ml-training","description":"ML model training...","steps":[...]}
       Response: {"id":"ml-001","name":"ml-training","steps":[...]}

[Q] "Activate this flow for the project now? (yes/no):"
User answers: yes

       MCP call: POST /projects/duaa8dto2g6wdyc75bvbuh/flow
       Body: {"flowId":"ml-001"}
       Response: {"success":true}

       Flow "ml-training" created and activated (ID: ml-001, 5 steps).
```

**Expected outcomes**:
- Every MCP call and response displayed (Opencode transparency requirement)
- Flow created with correct steps
- Activated for project
- `workflow_gatekeeper` returns `activeFlow.steps` with the 5 ML-specific steps on next call

---

### Scenario OC-2: MCP unavailable fallback

**Setup**: MCP server not running.

```
Agent: [Attempts list_projects() — fails]
       MCP server unavailable. Falling back to CLI.
       [Runs: agenfk list-projects --json]
       [Proceeds with agenfk flow create "<name>" --project <id>]
```

**Expected outcomes**: CLI used as fallback; skill still completes flow creation.

---

## Platform: Cursor

**Rule location**: `~/.cursor/rules/agenfk-flow.mdc`
**Invocation**: User-triggered (`alwaysApply: false`). Activated when user asks about flow creation.

---

### Scenario CU-1: Natural language activation

```
User: I want to set up a custom workflow for this project

Agent: [agenfk-flow rule activates because trigger phrase matched]

       I'll help you create a custom workflow flow for your AgenFK project.

       Step 1: Let me identify your project.
       [Reads .agenfk/project.json]
       Found project: "AgenFK Framework". Is that right?

User: Yes

Agent: What would you like to name this flow? (e.g. hotfix-process, feature-delivery)

User: hotfix-process

Agent: [Collects steps via chat: TRIAGE, FIX, EMERGENCY_REVIEW, DEPLOY, DONE]

Agent: Here's your proposed flow:

       Order | Name             | Label            | Exit Criteria              | Terminal?
       ------|------------------|------------------|---------------------------|----------
       1     | TRIAGE           | Triage           | Impact assessed, P0/P1?   | No
       2     | FIX              | Fixing           |                           | No
       3     | EMERGENCY_REVIEW | Emergency Review | Lead engineer approved    | No
       4     | DEPLOY           | Deploying        | Rolled out, monitoring ok | No
       5     | DONE             | Done             |                           | Yes

       Confirm? (yes / edit / cancel)

User: yes

Agent: [Runs curl -X POST http://localhost:3000/flows ...]
       Flow "hotfix-process" created (ID: hot-001, 5 steps).

User: Activate it for this project

Agent: [Runs: agenfk flow use hot-001 --project <projectId>]
       Activated! The hotfix-process flow is now live for this project.
```

---

### Scenario CU-2: Rule not triggered (correct non-activation)

```
User: How do I implement a search feature?

Agent: [agenfk-flow rule does NOT activate — no flow creation trigger phrase]
       [Agent responds normally about implementation]
```

**Expected outcome**: `alwaysApply: false` ensures the rule only engages when relevant.

---

### Scenario CU-3: MCP unavailable — REST fallback

**Setup**: Cursor has MCP configured but server is not running.

```
Agent: Cannot reach MCP server. Using CLI fallback.
       [Runs: agenfk list-projects --json to find projectId]
       [Runs: agenfk flow create "hotfix-process" --project <id>]
       [Then prompts user to enter each step interactively via the CLI]
```

---

## Platform: Codex

**Skill location**: `~/.codex/agenfk-flow.md`
**Invocation**: User asks Codex to create a flow. Codex reads `~/.codex/agenfk-flow.md` as instructions.

---

### Scenario CO-1: Standard flow creation

```
User: /agenfk-flow

Agent: Starting AgenFK Flow Manager.

       [Reads .agenfk/project.json]
       Project: "AgenFK Framework" (duaa8dto2g6wdyc75bvbuh). Correct?

User: Yes, create a compliance-review flow

Agent: I'll create a "compliance-review" flow.
       Would you like a description?

User: For regulated features requiring compliance sign-off

Agent: Let's add steps. What's step 1?

User: TODO

Agent: [Collects: TODO, IMPLEMENT, COMPLIANCE_REVIEW (exitCriteria: "GDPR checklist complete, DPO approval"), QA, DONE]

Agent: Preview:
       1. TODO
       2. IMPLEMENT
       3. COMPLIANCE_REVIEW — Exit: GDPR checklist complete, DPO approval
       4. QA
       5. DONE (terminal)

       Confirm? (yes / edit / cancel)

User: yes

Agent: [Runs: curl -X POST http://localhost:3000/flows ...]
       Created "compliance-review" (ID: comp-001).

       Activate for this project?

User: yes

Agent: [Runs: agenfk flow use comp-001 --project duaa8dto2g6wdyc75bvbuh]
       Done. compliance-review is now the active workflow.
```

**Note**: Codex does not support PreToolUse hooks. The skill instructions enforce compliance by instruction. The `workflow_gatekeeper` call is the authoritative gate.

---

### Scenario CO-2: Verify flow is active after creation

```
User: Show me the current flow

Agent: [Runs: agenfk flow show comp-001]
       [Displays all 5 steps in order with exit criteria]
```

---

## Platform: Gemini CLI

**Skill location**: `~/.gemini/agenfk-flow.md`
**Invocation**: User invokes `/agenfk-flow` Gemini command or asks naturally.

---

### Scenario GC-1: Create a data-pipeline flow

```
User: /agenfk-flow

Agent: AgenFK Flow Manager activated.

       [Reads .agenfk/project.json — found]
       Project: "AgenFK Framework" (duaa8dto2g6wdyc75bvbuh). Is that right?

User: Yes

Agent: What name should this flow have? (machine-safe, e.g. data-pipeline)

User: data-pipeline

Agent: Description?

User: For data engineering tasks with quality gates

Agent: Let's define the steps. Step 1 name? (blank to finish)

User: INGEST

Agent: Label? Exit criteria? Terminal step?

User: "Data Ingestion", "Source data validated, schema checked", no

[... collects TRANSFORM, QUALITY_CHECK (exitCriteria: ">99% data quality score), PUBLISH, DONE ...]

Agent: Flow preview:

       data-pipeline
       "For data engineering tasks with quality gates"

       Order | Name          | Label          | Exit Criteria                    | Terminal?
       ------|---------------|----------------|----------------------------------|----------
       1     | INGEST        | Data Ingestion | Source data validated            | No
       2     | TRANSFORM     | Transform      |                                 | No
       3     | QUALITY_CHECK | Quality Check  | >99% data quality score          | No
       4     | PUBLISH       | Publish        |                                 | No
       5     | DONE          | Done           |                                 | Yes

       Confirm? (yes / edit / cancel)

User: yes

Agent: [Calls: curl -s -X POST http://localhost:3000/flows \
         -H "Content-Type: application/json" \
         -d '{"name":"data-pipeline","description":"...","projectId":"...","steps":[...]}']

       Flow created: data-pipeline (ID: dp-001), 5 steps.
       Activate for this project now?

User: yes

Agent: [Calls: curl -s -X POST http://localhost:3000/projects/<id>/flow \
         -d '{"flowId":"dp-001"}']

       Activated. Inspect: agenfk flow show dp-001
```

**Note**: Gemini CLI does not support PreToolUse hooks. Instructions enforce compliance strictly. MCP tools are available via the agenfk MCP server registered during install.

---

### Scenario GC-2: MCP available path (preferred)

**Setup**: Gemini CLI has agenfk MCP registered. `list_projects()` MCP call is available.

```
Agent: [Calls list_projects() via MCP instead of CLI]
       [Uses MCP response to populate project list]
       [Proceeds with REST API for flow creation as per the skill instructions]
```

---

## Cross-Platform: Verify Flow-Aware Gatekeeper

After activating a custom flow, verify all platforms read the correct steps:

### Scenario XP-1: Gatekeeper returns active flow steps

**Setup**: `security-review` flow activated (steps: TODO, IN_PROGRESS, SEC_REVIEW, STAGING, DONE).

On any platform:

```
Agent: [Calls workflow_gatekeeper(intent, role="coding", itemId=<id>)]
Response includes:
{
  "authorized": true,
  "activeFlow": {
    "name": "security-review",
    "steps": [
      {"name": "TODO", "order": 1},
      {"name": "IN_PROGRESS", "order": 2},
      {"name": "SEC_REVIEW", "order": 3},
      {"name": "STAGING", "order": 4},
      {"name": "DONE", "order": 5, "isSpecial": true}
    ]
  }
}
```

Agent should use `SEC_REVIEW` (not `REVIEW`) and `STAGING` (not `TEST`) as the next steps.

Attempting `update_item(id, {status: "REVIEW"})` should be rejected by the server with:
`"FLOW VIOLATION: Cannot transition from 'IN_PROGRESS' to 'REVIEW' in the active flow 'security-review'"`

---

### Scenario XP-2: Reset to default flow

```
User: Reset to the default workflow

Agent: [Runs: agenfk flow reset --project <projectId>]
       Reset to default flow (TODO → IN_PROGRESS → REVIEW → TEST → DONE).
       workflow_gatekeeper will now return the default steps.
```

---

## Test Checklist

| # | Scenario | Platform | Pass criteria |
|---|----------|----------|---------------|
| CC-1 | Create basic flow | Claude Code | Flow created + activated, 5 steps |
| CC-2 | Multi-project selection | Claude Code | Correct projectId used |
| CC-3 | Edit existing flow | Claude Code | Step updated via PUT /flows/:id |
| CC-4 | Cancel mid-creation | Claude Code | No POST /flows call |
| OC-1 | Create flow + Question UI | OpenCode | MCP calls displayed, flow active |
| OC-2 | MCP unavailable fallback | OpenCode | CLI used, flow still created |
| CU-1 | Natural language trigger | Cursor | Rule activates, flow created |
| CU-2 | Non-activation | Cursor | Rule does NOT activate for unrelated request |
| CU-3 | MCP unavailable | Cursor | REST/CLI fallback used |
| CO-1 | Standard creation | Codex | Flow created via REST API |
| CO-2 | Show active flow | Codex | agenfk flow show returns correct steps |
| GC-1 | Create data-pipeline flow | Gemini CLI | Flow created via REST, activated |
| GC-2 | MCP available path | Gemini CLI | MCP tools used when available |
| XP-1 | Gatekeeper returns flow steps | All | activeFlow.steps matches custom flow |
| XP-2 | Reset to default | All | Default flow steps restored |
