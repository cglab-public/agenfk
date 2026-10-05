/**
 * @vitest-environment node
 *
 * What reopening preserves is SAID PER AGENT (dce6ee7d).
 *
 * The warning was wrong in both directions on the same day: first "you lose
 * everything", then "the conversation comes back", unconditionally. Both are
 * one sentence for agents that behave differently - and the reassuring
 * direction is the dangerous one, because it is the user who stops making
 * copies.
 */
import { describe, it, expect } from 'vitest';
import { reopenNotice } from '../main/agents.js';

describe('the reopen notice', () => {
  it('names only the agents whose conversation actually resumes', () => {
    const notice = reopenNotice([
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'pi', label: 'Pi' },
      { id: 'codex', label: 'Codex' },
      { id: 'gemini', label: 'Gemini CLI' },
      { id: 'shell', label: 'Shell' },
    ]);
    expect(notice).toContain('Claude Code, Pi');
    // codex resumes only by an id IT assigned, and gemini/shell have no
    // session descriptor: the sentence must not promise them.
    expect(notice).not.toContain('Codex');
    expect(notice).not.toContain('Gemini');
    expect(notice).toMatch(/other agents start fresh/);
  });

  it('says so when nothing installed can be resumed', () => {
    expect(reopenNotice([{ id: 'gemini', label: 'Gemini CLI' }])).toContain('no installed agent');
  });
});
