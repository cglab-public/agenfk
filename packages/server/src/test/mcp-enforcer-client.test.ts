import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Exercises the real agenfk-mcp-enforcer.mjs runtime with the new --client flag.
const enforcerPath = path.resolve(__dirname, '../../../../bin/agenfk-mcp-enforcer.mjs');

function runEnforcer(command: string, argv: string[] = []) {
  return spawnSync(process.execPath, [enforcerPath, ...argv], {
    input: JSON.stringify({ tool: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
}

describe('agenfk-mcp-enforcer --client gating', () => {
  it('does NOT block agenfk CLI state queries for a CLI-first client (pi)', () => {
    // Rule 3 (CLI-state-query block) is Claude-Code-specific; pi is CLI-first.
    const res = runEnforcer('agenfk list --json', ['--client', 'pi']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('still blocks the client-agnostic direct-DB bypass for pi', () => {
    const res = runEnforcer('cat .agenfk/db.sqlite', ['--client', 'pi']);
    const out = res.stdout.trim();
    expect(out.length).toBeGreaterThan(0);
    expect(JSON.parse(out).decision).toBe('block');
  });

  it('a trailing --client with no value falls back to the strict default (does not crash)', () => {
    // Direct-DB is agnostic, so it must still block regardless of client parsing.
    const res = runEnforcer('cat .agenfk/db.sqlite', ['--client']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).decision).toBe('block');
  });
});
