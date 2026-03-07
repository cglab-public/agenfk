# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.2.x (latest) | Yes |
| < 0.2.0 | No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting feature:

1. Go to the [Security tab](https://github.com/cglab-public/agenfk/security) of this repository.
2. Click **"Report a vulnerability"**.
3. Fill in the details — include steps to reproduce, impact, and suggested fix if known.

You will receive a response within 5 business days. We will work with you to assess and address the issue before any public disclosure.

## Scope

AgEnFK runs as a local service on your machine. Key areas of concern include:

- **MCP server**: Exposes a local API consumed by AI coding agents — any unauthenticated endpoints that could be abused.
- **CLI hooks**: PreToolUse hooks that execute shell commands — injection risks.
- **GitHub token handling**: `agenfk upgrade` uses `gh auth token` — any token leakage paths.
- **WebSocket server**: Real-time UI updates — any cross-origin issues.

## Out of Scope

- Vulnerabilities in third-party dependencies (report those upstream).
- Issues that require physical access to the machine running AgEnFK.
