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

describe('toRunEvent — secrets in shell commands', () => {
  /** Every one of these is a credential a developer types into a shell. */
  const leaky: Array<[string, string, string]> = [
    ['inline env assignment', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG aws s3 ls', 'wJalrXUtnFEMI'],
    ['bearer header', 'curl -H "Authorization: Bearer sk-live-abc123def456" https://api.example.com', 'sk-live-abc123def456'],
    ['github token', 'gh auth login --with-token <<< ghp_16CharsAndMoreHere0000', 'ghp_16CharsAndMoreHere0000'],
    ['openai key', 'export OPENAI_API_KEY=sk-proj-ZZZsecretZZZ && node run.js', 'sk-proj-ZZZsecretZZZ'],
    ['slack token', 'curl -d token=xoxb-111-222-abcdefSECRET https://slack.com/api/x', 'xoxb-111-222-abcdefSECRET'],
    ['url credentials', 'psql postgresql://admin:hunter2@db.internal/app', 'hunter2'],
    ['heredoc writing a dotenv', "cat > .env <<'EOF'\nAPI_KEY=sk-live-INSIDE-HEREDOC\nEOF", 'sk-live-INSIDE-HEREDOC'],
  ];

  for (const [name, command, secret] of leaky) {
    it(`redacts a ${name}`, () => {
      const event = toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } });
      expect(JSON.stringify(event), `${name} leaked into the run transcript`).not.toContain(secret);
    });
  }

  it('still says enough to recognise the command', () => {
    // Redaction that leaves nothing readable makes the transcript useless.
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'AWS_SECRET_ACCESS_KEY=shhh aws s3 cp build/ s3://bucket/' },
    });
    expect(event!.text).toContain('aws s3 cp');
  });

  it('leaves an innocuous command untouched', () => {
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run packages/server' },
    });
    expect(event!.text).toBe('npx vitest run packages/server');
  });
});

describe('toRunEvent — other leak paths', () => {
  it('drops the query string from a fetched URL', () => {
    // Presigned URLs ARE the credential: the signature is in the query.
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://s3.amazonaws.com/bucket/key?X-Amz-Signature=DEADBEEFSIG&x=1' },
    });
    expect(event!.text).toContain('s3.amazonaws.com/bucket/key');
    expect(JSON.stringify(event)).not.toContain('DEADBEEFSIG');
  });

  it('keeps a plain URL readable', () => {
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/docs/page' },
    });
    expect(event!.text).toBe('https://example.com/docs/page');
  });

  it('survives a malformed URL rather than throwing', () => {
    expect(() => toRunEvent({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: 'not a url' } })).not.toThrow();
  });

  it('names a notebook by its real field', () => {
    // Claude Code sends notebook_path, not file_path — reading the wrong one
    // made every notebook edit record the literal string "file".
    const event = toRunEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/repo/analysis.ipynb', new_source: 'print(1)' },
    });
    expect(event!.text).toContain('/repo/analysis.ipynb');
  });
});
