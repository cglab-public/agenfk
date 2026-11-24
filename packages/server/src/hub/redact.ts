/**
 * Redaction of a verify run's log before it leaves this machine (RFC-002).
 * The implementation lives in core (packages/core/src/redact.ts), so the CLI
 * can apply the same rules; this module keeps the server's import path.
 */
export { redactLog, type RedactOptions, type Redacted } from '@agenfk/core';
