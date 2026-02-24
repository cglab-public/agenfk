# Comparison: CAR Group AI Coding Guidelines vs. AgenFK Framework

This report compares the **CAR Group AI Coding Guidelines (Claude Code)** with the **AgenFK Engineering Framework**.

## 1. Core Coverage & Overlap

| Feature Area | CAR Group Guidelines | AgenFK Framework | Status |
| :--- | :--- | :--- | :--- |
| **Planning** | Shift+Tab Plan Mode, `.claude/plans/` | `analyze_request`, `implementationPlan`, Deep Mode decomposition | **Covered** (AgenFK is more structured) |
| **Workflow Phases** | Investigation -> Plan -> Build -> Verify | Understand -> Plan -> Implement -> Verify -> Test -> Close | **Covered** (Strong alignment) |
| **Verification** | Review changes, run tests, PR review | Mandatory `verify_changes`, 80% coverage rule, automated transitions | **Covered** (AgenFK is more prescriptive) |
| **Cost/Usage** | `/cost`, `/usage`, model selection (Sonnet/Opus) | `log_token_usage`, Board Report metrics (Tokens/Cycle Time) | **Covered** |
| **Configuration** | `CLAUDE.md`, hierarchical configs | `AFK_PROJECT_SCOPE.md`, `AFK_ARCHITECTURE.md`, `.agenfk/project.json` | **Covered** (Different filenames, same intent) |

## 2. Key Differences

### A. Enforcement vs. Guidance
- **Guidelines**: Focus on *how* to use the Claude Code CLI effectively (e.g., Shift+Tab, `/clear`). It relies on the developer to follow the steps.
- **AgenFK**: Mechanically enforces the workflow. The `workflow_gatekeeper` and `verify_changes` tools prevent state transitions (and potentially code changes) unless the correct protocols are followed.

### B. Planning Artifacts
- **Guidelines**: Uses local Markdown files in `.claude/plans/`.
- **AgenFK**: Stores plans directly in the MCP database (`implementationPlan` field) and uses `AFK_ARCHITECTURE.md` as a living document.

### C. State Machine
- **Guidelines**: Describes 4 high-level use cases.
- **AgenFK**: Implements a strict Kanban-style state machine (TODO -> IN_PROGRESS -> REVIEW -> TEST -> DONE) with mandatory parent-child status propagation rules.

## 3. Missing in AgenFK (Found in Guidelines)

- **CLI-Specific Tools**: Guidance on `/clear`, `/cost`, `/permissions`, and `/usage` commands.
- **Security Config**: Explicit instructions for `settings.json` deny rules and `.claudeignore`.
- **Custom Skills**: Use of custom slash commands in `.claude/commands/`.
- **Model Strategies**: Specific recommendations for when to use Sonnet vs. Opus vs. Haiku.

## 4. Missing in Guidelines (Found in AgenFK)

- **Metrification**: Detailed tracking of Cycle Time and Token Usage per task/story/epic.
- **Gatekeeper**: Role-based authorization (`planning`, `coding`, `testing`, etc.) to ensure the agent is in the right mindset.
- **Multi-Agent Orchestration**: Deep Mode's ability to spawn specialized sub-agents for review/test.
- **Coverage Mandates**: Strict 80% coverage requirements for moving tasks to DONE.

## Summary Conclusion
AgenFK provides a **mechanical implementation** of the principles described in the CAR Group Guidelines. While the Guidelines offer practical "CLI-native" tips (like keybindings and slash commands), AgenFK provides the **governance and reliability layer** that ensures those guidelines are actually followed consistently across a team.
