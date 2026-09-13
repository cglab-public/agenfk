/**
 * CGLAB-177: turning Claude Code hook payloads into agent-run events.
 *
 * The runs pipeline was built around the pi worker, which writes a JSONL
 * transcript the server tails. Claude Code writes no such file, so the bridge
 * goes the other way: its hooks push events into the API that already accepts
 * them. This file covers the mapping — the part with real decisions in it —
 * so the hook script stays a thin shell around tested logic.
 *
 * Two rules shape it. Never invent a kind the server will reject, because a
 * 400 in a hook is invisible to the user and the run silently loses events.
 * And never record secrets: a hook sees every tool input, including the full
 * text of files being written.
 */
import { describe, it, expect } from 'vitest';
import { toRunEvent, RUN_EVENT_KINDS } from '../agent-runs/claude-events';

describe('toRunEvent — shape', () => {
  it('maps a Bash tool call to a tool event naming the command', () => {
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run tests' },
    });
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('tool');
    expect(event!.tool).toBe('Bash');
    expect(event!.text).toContain('npm test');
  });

  it('only ever emits kinds the server accepts', () => {
    // A rejected kind is a 400 the user never sees, and a run that quietly
    // loses events. The valid set is the server's, mirrored here.
    const names = ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Task', 'WebFetch', 'Unknown'];
    for (const tool_name of names) {
      const event = toRunEvent({ hook_event_name: 'PostToolUse', tool_name, tool_input: {} });
      if (event) expect(RUN_EVENT_KINDS.has(event.kind)).toBe(true);
    }
  });

  it('marks a file edit as a diff, which is what it is', () => {
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
    });
    expect(event!.kind).toBe('diff');
    expect(event!.text).toContain('/repo/src/a.ts');
  });

  it('names the file for a Write without carrying its contents', () => {
    // A hook sees everything a tool is given. File bodies routinely contain
    // tokens and keys, and a run transcript is stored and rendered.
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.env', content: 'API_KEY=sk-live-SECRET-VALUE' },
    });
    expect(event!.text).toContain('/repo/.env');
    expect(JSON.stringify(event)).not.toContain('sk-live-SECRET-VALUE');
  });

  it('truncates a very long command instead of storing all of it', () => {
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ' + 'x'.repeat(5000) },
    });
    expect(event!.text!.length).toBeLessThan(1000);
  });
});

describe('toRunEvent — what should not be recorded', () => {
  it('ignores a payload with no tool name', () => {
    expect(toRunEvent({ hook_event_name: 'PostToolUse', tool_input: {} })).toBeNull();
  });

  it('ignores an empty payload rather than throwing', () => {
    expect(() => toRunEvent({} as never)).not.toThrow();
    expect(toRunEvent({} as never)).toBeNull();
  });

  it('ignores a null payload', () => {
    expect(toRunEvent(null as never)).toBeNull();
  });

  it('does not record reads — they are noise, not work', () => {
    // A transcript of every Read is unreadable and tells you nothing about
    // what the agent changed.
    expect(toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } })).toBeNull();
    expect(toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {} })).toBeNull();
  });

  it('survives a tool_input that is not an object', () => {
    expect(() => toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: 'oops' as never })).not.toThrow();
  });
});

describe('toRunEvent — lane', () => {
  it('records as the worker lane, which is what Claude Code is here', () => {
    const event = toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(event!.lane).toBe('worker');
  });

  it('records a sub-agent dispatch on the orchestrator lane', () => {
    // Spawning a Task IS orchestration, and showing it on the worker lane
    // would make a fan-out look like one agent doing everything.
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_input: { description: 'Review the diff', subagent_type: 'general-purpose' },
    });
    expect(event!.lane).toBe('orchestrator');
    expect(event!.kind).toBe('dispatch');
    expect(event!.text).toContain('Review the diff');
  });
});
