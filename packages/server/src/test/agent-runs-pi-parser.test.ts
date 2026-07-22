/**
 * pi.dev session JSONL → run transcript events (CGLAB-18b). Behaviour-based:
 * feeds a realistic pi transcript to the pure parser and asserts the events.
 */
import { describe, it, expect } from 'vitest';
import { parsePiSessionJsonl } from '../agent-runs/pi-parser';

const TRANSCRIPT = [
  JSON.stringify({ type: 'session', id: 's1', cwd: '/repo' }),
  JSON.stringify({ type: 'model_change', provider: 'qwen-cglab', modelId: 'qwen3.6:27b' }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'I will read the test file first.' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'packages/ui/src/test/KanbanBoard.test.tsx' } },
  ], usage: { totalTokens: 3018 } } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read',
    content: [{ type: 'text', text: 'file contents here' }], isError: false } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'npx vitest run' } },
  ], usage: { totalTokens: 1200 } } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'bash',
    content: [{ type: 'text', text: 'Tests 3 failed' }], isError: true } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
  '{"type":"message","message":{"role":"assistant"', // partial/incomplete trailing line
].join('\n');

describe('parsePiSessionJsonl', () => {
  const events = parsePiSessionJsonl(TRANSCRIPT);

  it('ignores session/model_change lines and skips the partial trailing line', () => {
    // 6 real events: think, tool(read), result, tool(bash), result, note
    expect(events).toHaveLength(6);
  });

  it('maps assistant thinking → think and attaches the turn token count to the first event', () => {
    expect(events[0]).toMatchObject({ lane: 'worker', kind: 'think', tokens: 3018 });
    expect(events[0].text).toContain('read the test file');
  });

  it('maps a toolCall → tool with a one-line arg summary', () => {
    expect(events[1]).toMatchObject({ lane: 'worker', kind: 'tool', tool: 'read' });
    expect(events[1].text).toBe('packages/ui/src/test/KanbanBoard.test.tsx');
    expect(events[3]).toMatchObject({ kind: 'tool', tool: 'bash', text: 'npx vitest run', tokens: 1200 });
  });

  it('maps toolResult → result carrying the error flag', () => {
    expect(events[2]).toMatchObject({ kind: 'result', tool: 'read', text: 'file contents here' });
    expect(JSON.parse(events[2].payload!)).toEqual({ isError: false });
    expect(events[4]).toMatchObject({ kind: 'result', tool: 'bash', text: 'Tests 3 failed' });
    expect(JSON.parse(events[4].payload!)).toEqual({ isError: true });
  });

  it('maps assistant plain text → note', () => {
    expect(events[5]).toMatchObject({ lane: 'worker', kind: 'note', text: 'Done.' });
  });

  it('truncates very long text', () => {
    const long = JSON.stringify({ type: 'message', message: { role: 'assistant',
      content: [{ type: 'thinking', thinking: 'x'.repeat(2000) }] } });
    const [ev] = parsePiSessionJsonl(long);
    expect(ev.text!.length).toBeLessThan(700);
    expect(ev.text!.endsWith('…')).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(parsePiSessionJsonl('')).toEqual([]);
  });
});
