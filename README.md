```text
                          __ _    
                         / _| |   
   __ _  __ _  ___ _ __ | |_| | __
  / _` |/ _` |/ _ \ '_ \|  _| |/ /
 | (_| | (_| |  __/ | | | | |   < 
  \__,_|\__, |\___|_| |_|_| |_|\_\
         __/ |                    
        |___/                     
```

# AgenFK: Agentic Engineering Framework

Welcome to **AgenFK**, a high-reliability, measurable, and visual framework designed to turn "Vibe Coding" into rigorous **Agentic Engineering**. AgenFK enforces a structured workflow that bridges the gap between autonomous AI agents and professional software engineering practices.

## Overview

AgenFK is built on six core mandates to ensure your AI-assisted development is consistent and high-quality:

*   **Agile**: Uses Epics, Stories, Tasks, and Bugs as first-class workflow items.
*   **Measurable**: Automatically tracks input/output tokens and models used for every single unit of work.
*   **Visual**: A real-time, hierarchical Kanban board provides instant oversight of the entire project state.
*   **Repeatable**: Uses standardized tools, prompt protocols, and context engineering to make AI behavior deterministic.
*   **Reliable**: Enforces mandatory verification (build/lint/test) before any work is declared "Done".
*   **Flexible**: Plugin-based architecture with support for MCP (Model Context Protocol), usable in Opencode, Cursor, Claude, and more.

## Installation & Setup

AgenFK is designed to bootstrap itself. To start using it in your project:

1.  **Clone** the AgenFK repository to a dedicated location on your system (e.g., `~/.agenfk-system`):
    ```bash
    git clone https://github.com/your-repo/agentic-framework.git ~/.agenfk-system
    cd ~/.agenfk-system
    ```
2.  **Run the 'Up' command**:
    ```bash
    ./agenfk up
    ```

    This single command will configure the framework for both **Opencode** and **Claude Code** simultaneously. It will:
    *   Install all dependencies.
    *   Build the core, CLI, server, and UI packages.
    *   Initialize the `.agenfk` metadata directory.
    *   Install the **MCP Server** and **Agent Skills** into your AI environment configurations.
    *   Install the **`/agenfk` slash command** in your AI editors.
    *   Start the **API Server** (Port 3000) and the **Web Dashboard** (Port 5173).

## Multi-Project Support

AgenFK supports managing multiple distinct projects from a single unified backend. 

*   **Local Linking**: Each local repository is linked to a database project via a `.agenfk/project.json` file.
*   **Automatic Context Switching**: When an AI Agent (via MCP) or a developer (via CLI) starts working on a task, the API server automatically detects the project context and broadcasts an event via WebSockets.
*   **Reactive Dashboard**: The Web UI instantly and automatically switches its Kanban view to the active project being worked on, keeping the developer perfectly in sync with the agent's actions.

## Architecture Deep Dive

AgenFK utilizes a **Single Owner Architecture** to ensure data consistency and real-time reactivity. This architecture prevents "split brain" scenarios where the AI agent and the human developer are looking at different states.

*   **API Server (The Owner)**: The heart of the framework. Built with Node.js and Express. It is the exclusive manager of the `db.json` storage. It actively watches the disk for changes and broadcasts real-time updates to all connected clients via **WebSockets**.
*   **MCP Server (The Bridge)**: A lightweight Model Context Protocol client. It exposes the AgenFK tools (`create_item`, `verify_changes`, `workflow_gatekeeper`, etc.) to AI Agents. Instead of modifying the database directly, it forwards all tool invocations to the API Server via HTTP, ensuring all actions are logged and broadcasted.
*   **CLI (The Interface)**: A unified command-line tool (`./agenfk`) written in TypeScript. It allows both humans and agents to manage the backlog and framework state. Like the MCP server, it acts as a client to the API Server.
*   **Web Dashboard (The UI)**: A modern React/Vite application utilizing TanStack Query for state management. It provides a hierarchical Kanban board, token metrics, detailed review reports, and seamless context switching.
*   **Storage (The Memory)**: Uses an atomic, file-based JSON storage plugin by default for maximum portability. The plugin uses temporary file swapping (`fs.renameSync`) to ensure atomic writes and prevent database corruption during concurrent operations.

## Core Workflow

The framework enforces a strict sequence of operations for every task. This process is fully automated and verified by the MCP tools and global skills:

```mermaid
graph TD
    A[User Request] --> B{Analyze Request}
    B -->|Epic| C[Generate Implementation Plan]
    B -->|Story/Task/Bug| D[Create Item]
    C --> D
    D --> E[Gatekeeper: Authorize Code Change]
    E -->|No Active Task| F[Pause: Select/Create Task]
    F --> E
    E -->|Authorized| G[Execute Code Changes]
    G --> H[Verify Changes <br><i>Runs build/test</i>]
    H -->|Failure| I[Auto-move to IN_PROGRESS<br>Report Errors]
    I --> G
    H -->|Success| J[Auto-move to DONE]
    J --> K[Log Token Usage]
    K --> L[Auto-sync Parent Status]
    
    style A fill:#f8fafc,stroke:#94a3b8,color:#334155
    style E fill:#eef2ff,stroke:#6366f1,stroke-width:2px,color:#3730a3
    style H fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,color:#92400e
    style J fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#065f46
```

1.  **Initialize**: Generate a `.agenfk/project.json` to link the local repository to an AgenFK project. *In Opencode or Claude Code, you can simply type `/agenfk` to have the agent set this up for you.*
2.  **Analyze**: Every request is analyzed to determine if it's an Epic, Story, Task, or Bug within the current project's scope.
3.  **Plan**: Epics require a Markdown **Implementation Plan** before work begins. This ensures the AI reasons about the architecture before writing code.
4.  **Authorize**: The `workflow_gatekeeper` ensures an agent only touches code when a specific task is `IN_PROGRESS`. This prevents rogue edits.
5.  **Verify**: The `verify_changes` tool executes stack-appropriate verification (e.g., `npm run build`, `pytest`) and automatically manages the transition from `REVIEW` to `DONE`. The results of these checks are permanently logged in the item's Review History.
6.  **Measure**: Token consumption is logged per task and aggregated at the Story and Epic levels, providing a clear cost/velocity metric.

## ⚡ Quick Start (Opencode & Claude Code)

If you are using Opencode or Claude Code, getting started is as easy as typing a single command in your prompt:

```text
/agenfk
```

This slash command will automatically load the framework skill, ask you to select or create a project context, and generate the foundational architecture documents (`AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md`) for your repository.

![AgenFK Dashboard](./docs/dashboard-screenshot.png)

---
*Built with ❤️ by the CG/lab AgenFK Platform Team.*
