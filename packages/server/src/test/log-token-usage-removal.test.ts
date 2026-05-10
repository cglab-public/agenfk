/**
 * Asserts the legacy `log_token_usage` MCP tool, its `TokenUsage` type, and
 * all related CLI/REST surface are removed from the codebase. The replacement
 * is server-side ingestion of per-client session-log files, landing as
 * `token_events` in storage.
 *
 * These tests fail before the removal and guide it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('legacy token-tracking removal', () => {
  describe('packages/server/src/index.ts', () => {
    let src: string;
    beforeAll(() => {
      src = read('packages/server/src/index.ts');
    });

    it('does not register the log_token_usage MCP tool', () => {
      expect(src).not.toMatch(/name:\s*["']log_token_usage["']/);
    });

    it('does not handle case "log_token_usage"', () => {
      expect(src).not.toMatch(/case\s+["']log_token_usage["']/);
    });

    it('does not declare LogTokenUsageSchema', () => {
      expect(src).not.toMatch(/LogTokenUsageSchema/);
    });
  });

  describe('packages/server/src/server.ts', () => {
    let src: string;
    beforeAll(() => {
      src = read('packages/server/src/server.ts');
    });

    it('PUT /items/:id no longer destructures or assigns tokenUsage', () => {
      // Allow the field to exist transiently in unrelated history; just ensure
      // we are not pulling it from the request body anymore.
      expect(src).not.toMatch(/\btokenUsage\b\s*[,}]/);
    });
  });

  describe('packages/cli/src/index.ts', () => {
    let src: string;
    beforeAll(() => {
      src = read('packages/cli/src/index.ts');
    });

    it('does not declare a log-tokens command', () => {
      expect(src).not.toMatch(/\.command\s*\(\s*['"]log-tokens/);
    });

    it('does not reference mcp__agenfk__log_token_usage', () => {
      expect(src).not.toMatch(/log_token_usage/);
    });
  });

  describe('packages/core/src/types.ts', () => {
    let src: string;
    beforeAll(() => {
      src = read('packages/core/src/types.ts');
    });

    it('does not define a TokenUsage interface', () => {
      expect(src).not.toMatch(/export\s+interface\s+TokenUsage\b/);
    });

    it('BaseItem does not declare a tokenUsage field', () => {
      // Match within the BaseItem interface block.
      const baseItemBlock = src.match(/export\s+interface\s+BaseItem\s*\{[\s\S]*?^\}/m)?.[0] ?? '';
      expect(baseItemBlock).not.toMatch(/\btokenUsage\b/);
    });
  });

  describe('per-client instruction docs', () => {
    const docs = [
      'clauderules/CLAUDE.md',
      'codexrules/AGENTS.md',
      'geminirules/GEMINI.md',
      'cursorrules/agenfk.mdc',
    ];

    for (const rel of docs) {
      it(`${rel} no longer references log_token_usage / log-tokens`, () => {
        const src = read(rel);
        expect(src).not.toMatch(/log_token_usage|agenfk\s+log-tokens/);
      });
    }
  });
});
