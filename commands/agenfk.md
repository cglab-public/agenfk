---
description: Initialize AgenFK and execute tasks in Standard Mode (Single Agent)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Standard Mode** protocol in the skill:
1. Proceed directly to implementation for simple tasks.
2. **MANDATORY**: Call `add_comment(itemId, content)` for every significant step (e.g. "Analyzed file X", "Implemented function Y", "Running tests").
3. Execute the entire lifecycle (Code, Verify, Close) proactively in this session.
4. **MANDATORY**: Use the `verify_changes` tool to run the project's test suite and ensure quality before closing.
5. Do not spawn specialized sub-agents.

