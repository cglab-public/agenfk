/**
 * BUG e78e78d2 — the author's identity on a verify, as the harness names it.
 * Codex was missing: a Codex author left no actor, so the review-record check
 * saw no authors, only warned, and a self-review passed. Verified against
 * Codex 0.155.1: commands it runs get CODEX_THREAD_ID, the id its transcript
 * (~/.codex/sessions/.../rollout-<ts>-<id>.jsonl, session_meta.payload.id) carries.
 */
import { describe, it, expect } from 'vitest';
import { harnessActor } from '../harnessModel';

describe('harnessActor', () => {
  it('names a Codex author by its thread id', () => {
    expect(harnessActor({ CODEX_THREAD_ID: '01a0d326-617d-73b1-ba6d-bd8b20b56ee2' }, '/nonexistent')).toEqual({ client: 'codex', sessionId: '01a0d326-617d-73b1-ba6d-bd8b20b56ee2' });
  });

  it('keeps naming a Claude Code author as before', () => {
    expect(harnessActor({ CLAUDE_CODE_SESSION_ID: 'abc-123' }, '/nonexistent')).toEqual({ client: 'claude-code', sessionId: 'abc-123' });
  });

  it('ignores a thread id that is not one', () => {
    expect(harnessActor({ CODEX_THREAD_ID: '../etc/passwd' }, '/nonexistent')).toBeNull();
  });

  it('knows nothing without a harness', () => {
    expect(harnessActor({}, '/nonexistent')).toBeNull();
  });
});
