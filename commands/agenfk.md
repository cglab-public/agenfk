---
description: Initialize AgenFK and execute tasks in Standard Mode (Single Agent)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Standard Mode** protocol in the skill:
1. Proceed directly to implementation for simple tasks.
2. Execute the entire lifecycle (Code, Verify, Close) proactively in this session.
3. Do not spawn specialized sub-agents.

