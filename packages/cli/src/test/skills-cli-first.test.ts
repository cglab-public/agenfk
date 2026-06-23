/**
 * Content regression test: every installed skill "flavor" must favor the
 * `agenfk` CLI over MCP tool calls.
 *
 * Pi (and codex/opencode/cursor/gemini) load each skill's SKILL.md
 * independently from ~/.agents/skills/<name>/ — derived from commands/*.md —
 * so each skill must be self-contained CLI-first, not lean on a separately
 * loaded rule bundle.
 *
 * Contract enforced here:
 *   - No skill references the removed `log_token_usage` tool.
 *   - In any skill file that mentions MCP tool names, the number of `agenfk `
 *     CLI invocations is >= the number of MCP tool-name mentions (CLI favored).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');

// MCP tool names that should no longer be the primary instruction.
const MCP_TOOLS = [
  'list_items', 'get_item', 'create_item', 'update_item', 'delete_item', 'move_item',
  'list_projects', 'create_project', 'update_project',
  'workflow_gatekeeper', 'validate_progress',
  'get_flow', 'list_flows', 'create_flow', 'update_flow', 'use_flow', 'delete_flow',
  'add_comment', 'add_context', 'register_pr', 'update_pr_sizing',
  'pause_work', 'resume_work', 'analyze_request', 'log_test_result',
  'review_changes', 'test_changes',
];
const MCP_RE = new RegExp(`\\b(${MCP_TOOLS.join('|')})\\b`, 'g');
const CLI_RE = /\bagenfk\s+[a-z]/g; // an `agenfk <verb>` invocation

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(md|mdc)$/.test(name)) out.push(p);
  }
  return out;
}

// Every command skill + every per-client flavor file + the master SKILL.md.
const skillFiles = [
  ...walk(path.join(root, 'commands')),
  ...walk(path.join(root, 'skills')),
  path.join(root, 'SKILL.md'),
];

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

describe('skill flavors favor the agenfk CLI', () => {
  it('found skill files to check', () => {
    expect(skillFiles.length).toBeGreaterThan(10);
  });

  it.each(skillFiles.map(f => [path.relative(root, f), f] as const))(
    '%s does not reference the removed log_token_usage tool',
    (_rel, file) => {
      expect(readFileSync(file, 'utf8')).not.toMatch(/log_token_usage/);
    }
  );

  it.each(skillFiles.map(f => [path.relative(root, f), f] as const))(
    '%s favors the CLI (agenfk CLI mentions >= MCP tool mentions)',
    (_rel, file) => {
      const content = readFileSync(file, 'utf8');
      const mcp = count(content, MCP_RE);
      if (mcp === 0) return; // nothing to convert
      const cli = count(content, CLI_RE);
      expect(cli).toBeGreaterThanOrEqual(mcp);
    }
  );

  it.each(skillFiles.map(f => [path.relative(root, f), f] as const))(
    '%s favors --json over --toon for read output',
    (_rel, file) => {
      const content = readFileSync(file, 'utf8');
      const toon = count(content, /--toon/g);
      const json = count(content, /--json/g);
      // Skill instructions should use --json as the read format.
      expect(json).toBeGreaterThanOrEqual(toon);
    }
  );
});
