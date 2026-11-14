/**
 * The sourcePath a run is registered with (BUG 53ed7163).
 *
 * The tailer resolves it once the agent has written its session file, so the
 * pattern has to point at the right SHAPE - and a wrong one fails silently
 * (no file, no events), which is why the shapes are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { agentRunSourcePath } from '../main/agentRunSource';

describe('where a run says its transcript will be', () => {
  it('points pi at the id-keyed session file', () => {
    // ~/.pi/agent/sessions/<project>/<ISO-timestamp>_<session-id>.jsonl
    expect(agentRunSourcePath('pi', 'abc-123')).toBe('~/.pi/agent/sessions/*/*_abc-123.jsonl');
  });

  it('points claude at its project transcript', () => {
    expect(agentRunSourcePath('claude-code', 'abc-123')).toBe('~/.claude/projects/*/abc-123.jsonl');
  });

  it('says NOTHING for a harness we cannot key on', () => {
    // codex and gemini resume by directory, not by an id we mint. A pattern
    // that matches nothing is indistinguishable from a silent run.
    expect(agentRunSourcePath('codex', 'abc-123')).toBeUndefined();
    expect(agentRunSourcePath('gemini', 'abc-123')).toBeUndefined();
  });

  it('says nothing when there is no session id to follow', () => {
    expect(agentRunSourcePath('pi', undefined)).toBeUndefined();
    expect(agentRunSourcePath('claude-code', undefined)).toBeUndefined();
  });
});
