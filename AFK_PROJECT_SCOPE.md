# AgenFK Project Scope

## Objective
AgenFK is an Agentic Framework for building, managing, and maintaining software engineering projects using a highly structured workflow that agents can easily reason about and act upon via MCP tools.

## Coverage Goals
- MANDATORY >= 80% coverage on all packages
- Testing CLI interactions
- Testing Express Server APIs and WebSockets
- Testing React UI components and custom hooks

## Current Status
- Unit tests written for `core`, `storage-json`, `server`, `cli`, and `ui` packages
- Overall project coverage is approximately ~82%.
- `core`, `storage-json`, and `storage-sqlite` packages have achieved >95% code coverage.
- `server` has achieved >85% logic coverage.
- `cli` and `ui` packages are being brought up to the >80% threshold.
- Code coverage goal is now a hard requirement enforced via Vitest and the `agenfk` workflow.
