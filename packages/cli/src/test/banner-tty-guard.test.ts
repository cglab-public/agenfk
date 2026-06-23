/**
 * Content regression test: the CLI figlet banner must NOT print when stdout is
 * captured/piped (the agent case), only in an interactive terminal.
 *
 * The banner runs on every non-`--json`, non-`mcp` command — including mutating
 * commands like `create`/`comment`/`verify` that take neither flag. When an
 * agent captures stdout via a shell, the ~10-line ASCII banner (~87 tokens) is
 * read straight back into context as pure waste. Gating on `process.stdout.isTTY`
 * keeps the banner for humans at a terminal and drops it for piped/captured runs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const CLI_PATH = path.resolve(__dirname, '../index.ts');

describe('CLI banner is gated on an interactive TTY', () => {
  it('the figlet banner block guards on process.stdout.isTTY', () => {
    const cli = readFileSync(CLI_PATH, 'utf8');
    // Find the figlet banner emission and inspect its guarding condition.
    const figletIdx = cli.indexOf("figlet.textSync('AgEnFK'");
    expect(figletIdx).toBeGreaterThan(-1);
    // The guarding `if (...)` is just above the emission; look back a short window.
    const guard = cli.slice(Math.max(0, figletIdx - 400), figletIdx);
    expect(guard).toMatch(/process\.stdout\.isTTY/);
  });

  it('still suppresses for --json and mcp (existing contract preserved)', () => {
    const cli = readFileSync(CLI_PATH, 'utf8');
    const figletIdx = cli.indexOf("figlet.textSync('AgEnFK'");
    const guard = cli.slice(Math.max(0, figletIdx - 400), figletIdx);
    expect(guard).toMatch(/--json/);
    expect(guard).toMatch(/'mcp'|"mcp"/);
  });
});
