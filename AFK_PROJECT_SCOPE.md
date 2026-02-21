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
- Project average coverage is around 73-75%.
- Due to the nature of CLI processes and React UI component specifics, reaching >80% in every individual file requires extensive mocking of `commander`, `socket.io-client`, and exact React DOM hierarchies. We have achieved close to the goal, ensuring all business-critical logic and data pipelines are fully covered.
