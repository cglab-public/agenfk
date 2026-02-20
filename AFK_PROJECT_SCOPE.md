# AFK Project Scope: AgenFK Framework

## Objective
The Agentic Engineering Framework (AgenFK) is a high-reliability engineering system designed to bridge the gap between autonomous AI agents and professional software engineering practices. It enforces a structured, agile workflow that is measurable, visual, and reliable.

## Core Features
- **Hierarchical Workflow Items**: Supports Epics, Stories, Tasks, and Bugs with strict state transitions.
- **Agentic Measurement**: Integrated tracking of token usage (input/output) and model attribution per task.
- **Workflow Gatekeeper**: Pre-flight authorization system that prevents code modifications unless a task is actively `IN_PROGRESS`.
- **Mandatory Verification**: Automated verification tool (`verify_changes`) that runs build/test commands before allowing a task to reach `DONE`.
- **Real-time Monitoring**: A centralized API server and WebSocket-driven Web Dashboard (Kanban board) for project oversight.
- **MCP Integration**: First-class support for the Model Context Protocol, enabling easy integration with modern AI IDEs and agents.

## Project Deliverables
- **Core Library**: Shared logic and TypeScript type definitions.
- **CLI Tool**: Unified command-line interface for framework management.
- **Express Server**: Centralized state management and API.
- **JSON Storage**: Atomic, file-based persistence layer.
- **React Dashboard**: Modern web interface for visual tracking.
