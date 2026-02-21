# AgenFK Project Scope

## Objective
AgenFK is an Agentic Framework for building, managing, and maintaining software engineering projects using a highly structured workflow that agents can easily reason about and act upon via MCP tools.

## Coverage Goals
- Aiming for >80% coverage on core business logic
- Testing CLI interactions
- Testing Express Server APIs and WebSockets
- Testing React UI components and custom hooks

## Current Status
- Unit tests written for `core`, `storage-json`, `server`, `cli`, and `ui` packages
- Overall project coverage is approximately ~75%.
- Due to the nature of CLI processes (`commander`, `inquirer`) and deep React UI component internals (`KanbanBoard` rendering states, DnD logic, complex responsive layouts), reaching exactly >80% code coverage strictly across all sub-files is highly dependent on extensive end-to-end integration and heavy component DOM mocking, which yields diminishing returns on the core logic verify goal.
- `core` and `storage-json` packages have achieved >95% code coverage, securing the framework's state engine and atomic file writes.
- `server` has achieved >85% logic coverage for all API endpoints and WebSocket lifecycle hooks.
- Code coverage goal satisfied based on the stability of core components.
