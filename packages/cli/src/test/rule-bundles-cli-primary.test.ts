/**
 * Content regression tests for the installed rule bundles.
 *
 * AgEnFK is CLI-only by default (MCP is opt-in via --with-mcp) for every client
 * EXCEPT Codex. Codex's sandbox often blocks localhost, so it is MCP-primary and
 * gets the MCP server by default (see codex-mcp-default.test.ts). Regardless of
 * which surface is primary, every installed bundle must still:
 *   - document the full CLI surface, including the commands that close the
 *     former MCP-only gaps (pause-work, resume-work, update-project,
 *     add-context, flow delete, analyze)
 *   - NOT instruct agents to never use the CLI
 *   - reference the token-optimized --toon switch
 * and each bundle must accurately state whether MCP is opt-in (default) or the
 * primary surface (Codex).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const BUNDLES = [
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'cursorrules/agenfk.mdc',
  'geminirules/GEMINI.md',
];

describe.each(BUNDLES)('rule bundle %s — CLI-primary', (bundle) => {
  const content = read(bundle);

  it('does not tell the agent to NEVER use the agenfk CLI', () => {
    expect(content).not.toMatch(/NEVER use the `?agenfk`? CLI/i);
  });

  it('references the agenfk gatekeeper CLI command for pre-edit authorization', () => {
    expect(content).toMatch(/agenfk gatekeeper/);
  });

  it('documents the new pause-work / resume-work CLI commands', () => {
    expect(content).toMatch(/agenfk pause-work/);
    expect(content).toMatch(/agenfk resume-work/);
  });

  it('documents update-project, add-context, flow delete and analyze CLI commands', () => {
    expect(content).toMatch(/agenfk update-project/);
    expect(content).toMatch(/agenfk add-context/);
    expect(content).toMatch(/agenfk flow delete/);
    expect(content).toMatch(/agenfk analyze/);
  });

  it('states its MCP posture — Codex is MCP-primary/default; others are opt-in (--with-mcp)', () => {
    if (bundle === 'codexrules/AGENTS.md') {
      // Codex: MCP is the primary surface, registered by default.
      expect(content).toMatch(/mcp__agenfk__/);
      expect(content.toLowerCase()).toMatch(/default for codex|default\b[\s\S]{0,40}codex|codex[\s\S]{0,40}default/);
    } else {
      expect(content).toMatch(/--with-mcp/);
    }
  });

  it('documents --json as the read output format', () => {
    expect(content).toMatch(/--json/);
  });
});

describe('pause/resume command docs use the CLI', () => {
  it('agenfk-pause.md references agenfk pause-work', () => {
    expect(read('commands/agenfk-pause.md')).toMatch(/agenfk pause-work/);
  });

  it('agenfk-resume.md references agenfk resume-work', () => {
    expect(read('commands/agenfk-resume.md')).toMatch(/agenfk resume-work/);
  });
});
