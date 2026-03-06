# Comparison: CAR Group AI Coding Guidelines vs. AgenFK Framework

This report compares the **CAR Group AI Coding Guidelines (Claude Code)** with the **AgenFK Engineering Framework**, analysing coverage, differences, and complementary strengths.

## 1. Core Coverage & Overlap

| Feature Area | CAR Group Guidelines | AgenFK Framework | Status |
| :--- | :--- | :--- | :--- |
| **Planning** | Shift+Tab Plan Mode, `.claude/plans/`, mandatory plan review by Senior/Tech Lead for complex tasks | `analyze_request`, `implementationPlan` field, Deep Mode decomposition with mandatory PAUSE for human approval | **Covered** (AgenFK mechanically enforces plan-before-code; Guidelines rely on human discipline) |
| **Workflow Phases** | 4 use-case-specific workflows (see Section 2C) | Strict state machine: TODO &rarr; IN_PROGRESS &rarr; REVIEW &rarr; TEST &rarr; DONE | **Covered** (Strong alignment; AgenFK is more uniform) |
| **Verification** | "Review all changes", "Run full test suite", PR review | Mandatory `validate_progress` tool with per-step exit criteria, automated intermediate step transitions to DONE, 80% coverage enforcement via `enforce-coverage.ts` | **Covered** (AgenFK is more prescriptive) |
| **Cost/Usage** | `/cost`, `/usage`, session-usage pricing model, weekly limits | `log_token_usage` per item, Board Report metrics (Token totals, Cycle Time, Averages) | **Covered** (Different focus: Guidelines advise cost *optimisation*; AgenFK tracks cost *metrics*) |
| **Configuration** | `CLAUDE.md` (3-level hierarchy: global, project, personal override), `.claudeignore` | `AFK_PROJECT_SCOPE.md`, `AFK_ARCHITECTURE.md`, `.agenfk/project.json`, `SKILL.md` | **Covered** (Different filenames, same intent) |
| **Complexity Classification** | Strategic / Complex / Simple (tied to seniority gates) | TASK / STORY / EPIC (with signal-based classification rules in Step 0) | **Covered** (Parallel concepts, different taxonomies) |
| **Custom Commands** | `.claude/commands/` for reusable team prompts | `/agenfk`, `/agenfk-deep`, `/agenfk-test`, `/agenfk-release` slash commands | **Covered** (Both use slash commands; AgenFK's are framework-specific) |

## 2. Key Differences

### A. Enforcement vs. Guidance

- **Guidelines**: Describe *best practices* for using the Claude Code CLI (e.g., Shift+Tab for planning, `/clear` for session hygiene). They include human review gates (Senior/Tech Lead plan review) but rely on team discipline to follow them.
- **AgenFK**: Mechanically enforces the workflow. The `workflow_gatekeeper` rejects code changes unless a task is `IN_PROGRESS` and the agent's role matches the current phase. `validate_progress` prevents items reaching DONE without passing build and test gates at each intermediate step. A PreToolUse hook in CLAUDE.md provides an additional enforcement layer.

### B. Planning Artifacts

- **Guidelines**: Plans are local Markdown files in `.claude/plans/` with slugified names. Execution is manual — reference the filename in a new session.
- **AgenFK**: Plans are stored in the MCP database (`implementationPlan` field) with full traceability. For EPICs, a dedicated `/agenfk-plan` command decomposes work into child items and requires human approval before any coding begins.

### C. Workflow Models

- **Guidelines**: Define 4 distinct use-case workflows, each with different phase compositions:
  - **UC1 (New Project)**: PLAN &rarr; PLAN REVIEW &rarr; BUILD &rarr; VERIFY (Strategic, Senior/Tech Lead only)
  - **UC2 (Complex Feature)**: PLAN &rarr; PLAN REVIEW &rarr; BUILD &rarr; VERIFY/TEST (Complex)
  - **UC3 (Simple Bug Fix)**: INVESTIGATE &rarr; DIAGNOSE &rarr; PLAN &rarr; BUILD &rarr; TEST (Simple)
  - **UC4 (Refactoring)**: PLAN &rarr; PLAN REVIEW &rarr; BUILD &rarr; VERIFY (Complex)
- **AgenFK**: Implements a single, uniform Kanban state machine (TODO &rarr; IN_PROGRESS &rarr; REVIEW &rarr; TEST &rarr; DONE) applied to all item types. Complexity is handled through item *type* (TASK vs. STORY vs. EPIC) and *mode* (Standard vs. Deep), not through different workflows.

### D. Scope of Applicability

- **Guidelines**: Explicitly position Claude Code for use beyond coding — including **Technical Discussion**, **Debugging** (third-party library issues, error analysis), **Codebase Navigation**, and **Documentation** generation. These are first-class use cases.
- **AgenFK**: Focused exclusively on **software engineering task execution**. Non-coding activities (discussion, exploration, documentation) are not tracked or governed by the framework.

### E. Human Review Gates

- **Guidelines**: Mandate Senior/Tech Lead review of plans for Complex and Strategic tasks (UC1, UC2, UC4). This is a seniority-based governance model.
- **AgenFK**: In Standard Mode, uses automated self-review (the agent re-reads its own changes). In Deep Mode, spawns a dedicated Review Agent for code audit. Human approval is required only at the plan decomposition stage (PAUSE before coding), not at the code review stage.

### F. Session & Context Management

- **Guidelines**: Provide detailed operational advice — context overload at ~50% (100k tokens), mandatory `/clear` between tasks, warning that model switching mid-session doubles context cost, and iterative CLAUDE.md updates.
- **AgenFK**: Does not address session lifecycle or context management. The framework assumes the agent operates within a single task lifecycle and delegates session hygiene to the host tool (Claude Code, Opencode, etc.).

## 3. Missing in AgenFK (Found in Guidelines)

| Gap | Description | Impact |
| :--- | :--- | :--- |
| **Context Management** | No guidance on context overload thresholds, `/clear` cadence, or session hygiene. | Agents may degrade in quality during long sessions without external guidance. |
| **Model Selection Strategy** | No recommendations for when to use Sonnet vs. Opus vs. Haiku. | Cost optimisation is left to the operator; no framework-level model routing. |
| **Security Configuration** | No equivalent of `settings.json` deny rules or `.claudeignore` for sensitive file protection. | Security boundaries must be configured outside the framework. |
| **Non-Coding Use Cases** | No support for tracking or governing technical discussions, debugging sessions, or documentation tasks. | These activities fall outside AgenFK's workflow entirely. |
| **Cost Optimisation Advice** | Tracks token usage but doesn't advise on reducing it (e.g., avoid model switching, use `/clear`). | Metrics without actionable guidance. |
| **Seniority-Based Gates** | No concept of role-based human review (Senior/Tech Lead approval). | Human oversight in AgenFK is limited to plan approval in Deep Mode. |

## 4. Missing in Guidelines (Found in AgenFK)

| Gap | Description | Impact |
| :--- | :--- | :--- |
| **Metrification** | Detailed per-item tracking of Cycle Time and Token Usage, aggregated at Story/Epic levels with Board Report summaries. | Guidelines have no equivalent project-wide metrics or reporting. |
| **Mechanical Gatekeeper** | Role-based authorization (`planning`, `coding`, `review`, `testing`, `closing`) enforced via MCP tool before every code change. | Guidelines rely on developer discipline; AgenFK prevents unauthorized changes mechanically. |
| **Multi-Agent Orchestration** | Deep Mode spawns specialized sub-agents (Planning, Coding, Review, Testing, Closing) with automated handover and parallel execution. | Guidelines assume a single developer-agent pair. |
| **Coverage Enforcement** | Strict 80% coverage threshold enforced by `enforce-coverage.ts` and `validate_progress` (final step), with per-file and overall checks. | Guidelines say "ensure tests" but define no numerical threshold. |
| **Real-Time Visualization** | Kanban board with WebSocket-driven live updates, drag-and-drop prioritisation, and hierarchical item views. | Guidelines are text-only with no visual project oversight. |
| **Progress Audit Trail** | Mandatory `add_comment` logging for every significant agent step, visible in real-time on the Kanban board. | Guidelines have no equivalent step-by-step logging mechanism. |
| **Conventional Commits** | Enforces standard prefixes (`fix:`, `feat:`, `chore:`, etc.) with item ID references. | Guidelines don't prescribe commit message conventions. |
| **Parent-Child Propagation** | Automatic status propagation — a parent (EPIC/STORY) can only advance when ALL children have reached that state or further. | Guidelines have no concept of hierarchical work item management. |
| **Item Type Classification** | Signal-based rules (file count, package count, deliverable count) for choosing TASK vs. STORY vs. EPIC. | Guidelines classify by complexity label only, without structured decision criteria. |

## 5. Complementary Strengths

The two frameworks are not in competition — they address different layers of the same problem:

| Layer | CAR Group Guidelines | AgenFK Framework |
| :--- | :--- | :--- |
| **Operational** | How to use the CLI effectively (keybindings, sessions, models) | N/A — delegates to host tool |
| **Process** | Best practices and team conventions (plan review, PR flow) | Mechanical enforcement of workflow phases |
| **Governance** | Seniority-based human review gates | Automated gatekeeper + verification tools |
| **Measurement** | Cost awareness (`/cost`, `/usage`) | Full metrification (tokens, cycle time, coverage) |
| **Visualisation** | N/A — text-based workflow | Real-time Kanban dashboard |
| **Scalability** | Single agent-developer pair | Multi-agent orchestration (Deep Mode) |

## Summary

AgenFK provides a **mechanical implementation** of the engineering principles described in the CAR Group Guidelines, while the Guidelines provide **operational and strategic context** that AgenFK does not address. The Guidelines tell teams *what to do and why*; AgenFK ensures *it actually happens*. An organisation using both would benefit from the Guidelines' CLI-native tips, model strategy, and session management layered on top of AgenFK's enforcement, metrification, and visualisation.
