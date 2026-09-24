/**
 * BUG e78e78d2 — the MCP validate path records the author the harness that
 * launched the MCP server names: Claude Code (CLAUDE_CODE_SESSION_ID) or Codex
 * (CODEX_THREAD_ID). It used to read Claude Code's only.
 */
import { describe, it, expect } from 'vitest';
import { actorFromEnv } from '../reviewRecords';

describe('actorFromEnv', () => {
  it('names Claude Code', () => {
    expect(actorFromEnv({ CLAUDE_CODE_SESSION_ID: 's-1' })).toEqual({ client: 'claude-code', sessionId: 's-1' });
  });
  it('names Codex', () => {
    expect(actorFromEnv({ CODEX_THREAD_ID: '01a0d326-617d-73b1-ba6d-bd8b20b56ee2' })).toEqual({ client: 'codex', sessionId: '01a0d326-617d-73b1-ba6d-bd8b20b56ee2' });
  });
  it('refuses ids that are not ids', () => {
    expect(actorFromEnv({ CODEX_THREAD_ID: 'a b' })).toBeUndefined();
    expect(actorFromEnv({})).toBeUndefined();
  });
});
