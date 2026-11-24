/**
 * GH-398: a Claude Code transcript names the card it works on through its own
 * agenfk calls. The parser reports those claims next to the turns: a
 * gatekeeper the server authorized (`--item-id`, or the card its reply names),
 * every verify of a card (the server records the session on the card whatever
 * the verify's outcome), and the same calls through the agenfk MCP tools. A
 * claim is dated by the call, not by its reply: the call is when the server
 * saw it, and a closing verify's close lands before its reply is written.
 * Subagent records carry their agentId, which the turns keep.
 */
import { describe, it, expect } from 'vitest';
import { parseClaudeCodeJsonl } from '../token-ingestion/parsers/claude-code';
import type { ParserContext } from '../token-ingestion/watcher';

const SESSION = 'sess-1';
const FULL = 'a1bd01e5-b78a-42b4-9d97-88c4a848ea44';

let n = 0;
const call = (ts: string, command: string, extra: Record<string, unknown> = {}) => {
  const id = `toolu_${++n}`;
  return {
    id,
    line: JSON.stringify({
      type: 'assistant', timestamp: ts, sessionId: SESSION, cwd: '/repo', ...extra,
      message: { id: `msg_${n}`, model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    }),
  };
};
const mcpCall = (ts: string, name: string, input: Record<string, unknown>) => {
  const id = `toolu_${++n}`;
  return {
    id,
    line: JSON.stringify({
      type: 'assistant', timestamp: ts, sessionId: SESSION,
      message: { id: `msg_${n}`, model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] },
    }),
  };
};
const result = (ts: string, toolUseId: string, content: unknown, isError = false, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user', timestamp: ts, sessionId: SESSION, ...extra,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
});

function parse(lines: string[], ctx: ParserContext = {}) {
  const claims: any[] = [];
  const c: ParserContext = { ...ctx, claims };
  const events = parseClaudeCodeJsonl(lines.join('\n') + '\n', '/p/sess-1.jsonl', 0, c);
  return { events, claims, state: c.state };
}

describe('parseClaudeCodeJsonl: transcript claims (GH-398)', () => {
  it('claims the card of an authorized gatekeeper, at the time of the call', () => {
    const gk = call('2026-11-20T10:00:00.000Z', `cd /repo && agenfk gatekeeper --intent "x y" --item-id ${FULL}`);
    const { claims } = parse([gk.line, result('2026-11-20T10:00:05.000Z', gk.id, '✅ AUTHORIZED (CODING).\n\nBUG: [a1bd01e5] t')]);
    expect(claims).toEqual([{ sessionId: SESSION, agentId: '', itemRef: FULL, at: '2026-11-20T10:00:00.000Z' }]);
  });

  it('takes the --item-id= form and a short id as written (resolved later)', () => {
    const gk = call('2026-11-20T10:00:00.000Z', 'agenfk gatekeeper --item-id=a1bd01e5 --intent "x"');
    const { claims } = parse([gk.line, result('2026-11-20T10:00:01.000Z', gk.id, '✅ AUTHORIZED (CODING).')]);
    expect(claims.map((c) => c.itemRef)).toEqual(['a1bd01e5']);
  });

  it('does not claim a card the gatekeeper refused, whether or not the shell failed', () => {
    const piped = call('2026-11-20T10:00:00.000Z', `agenfk gatekeeper --intent "x" --item-id ${FULL} 2>&1 | tail -3`);
    const failed = call('2026-11-20T10:01:00.000Z', `agenfk gatekeeper --intent "x" --item-id ${FULL}`);
    const { claims } = parse([
      piped.line, result('2026-11-20T10:00:01.000Z', piped.id, `❌ WORKFLOW BREACH: Item [${FULL}] is not in an active working step.`),
      failed.line, result('2026-11-20T10:01:01.000Z', failed.id, 'Exit code 1\n❌ WORKFLOW BREACH', true),
    ]);
    expect(claims).toEqual([]);
  });

  it('claims a gatekeeper whose reply was cut away by the shell, unless the call failed', () => {
    const cut = call('2026-11-20T10:00:00.000Z', `agenfk gatekeeper --intent "x" --item-id ${FULL} | head -0`);
    const errored = call('2026-11-20T10:01:00.000Z', `agenfk gatekeeper --intent "x" --item-id 0000aaaa`);
    const { claims } = parse([
      cut.line, result('2026-11-20T10:00:01.000Z', cut.id, ''),
      errored.line, result('2026-11-20T10:01:01.000Z', errored.id, 'Exit code 1', true),
    ]);
    expect(claims.map((c) => c.itemRef)).toEqual([FULL]);
  });

  it('a gatekeeper without --item-id claims the card its authorization names', () => {
    const gk = call('2026-11-20T10:00:00.000Z', 'agenfk gatekeeper --intent "edit"');
    const json = call('2026-11-20T10:05:00.000Z', 'agenfk gatekeeper --intent "edit" --json');
    const { claims } = parse([
      gk.line, result('2026-11-20T10:00:01.000Z', gk.id, '✅ AUTHORIZED (CODING).\n\nTASK: [b2c3d4e5] Some title\nCurrent step: X'),
      json.line, result('2026-11-20T10:05:01.000Z', json.id, JSON.stringify({ authorized: true, task: { id: FULL, title: 't' } })),
    ]);
    expect(claims.map((c) => c.itemRef)).toEqual(['b2c3d4e5', FULL]);
  });

  it('every verify of a card claims it, even one that failed; a --plan dry run does not', () => {
    const ok = call('2026-11-20T10:00:00.000Z', `agenfk verify ${FULL} --evidence "a && b; c"`);
    const red = call('2026-11-20T10:10:00.000Z', 'cd /repo && agenfk verify "c0ffee12" --evidence "x"');
    const plan = call('2026-11-20T10:20:00.000Z', 'agenfk verify d00dfeed --plan');
    const { claims } = parse([
      ok.line, result('2026-11-20T10:00:30.000Z', ok.id, 'Item is now on REVIEW.'),
      red.line, result('2026-11-20T10:10:30.000Z', red.id, 'Exit code 1\n❌ Verification FAILED', true),
      plan.line, result('2026-11-20T10:20:01.000Z', plan.id, 'Leaving X runs nothing.'),
    ]);
    expect(claims.map((c) => [c.itemRef, c.at])).toEqual([
      [FULL, '2026-11-20T10:00:00.000Z'],
      ['c0ffee12', '2026-11-20T10:10:00.000Z'],
    ]);
  });

  it('ignores agenfk commands that name no card the session works on', () => {
    const others = call('2026-11-20T10:00:00.000Z', `agenfk get ${FULL} --json && agenfk review brief ${FULL} && echo "agenfk verify"`);
    const { claims } = parse([others.line, result('2026-11-20T10:00:01.000Z', others.id, '{}')]);
    expect(claims).toEqual([]);
  });

  it('claims through the agenfk MCP tools too', () => {
    const gk = mcpCall('2026-11-20T10:00:00.000Z', 'mcp__agenfk__workflow_gatekeeper', { intent: 'x', itemId: 'b2c3d4e5' });
    const vp = mcpCall('2026-11-20T10:10:00.000Z', 'mcp__agenfk__validate_progress', { itemId: FULL, evidence: 'e' });
    const refused = mcpCall('2026-11-20T10:20:00.000Z', 'mcp__agenfk__workflow_gatekeeper', { intent: 'x', itemId: 'deadbeef' });
    const { claims } = parse([
      gk.line, result('2026-11-20T10:00:01.000Z', gk.id, [{ type: 'text', text: '✅ AUTHORIZED (CODING).' }]),
      vp.line, result('2026-11-20T10:10:01.000Z', vp.id, [{ type: 'text', text: 'Item is now on REVIEW.' }]),
      refused.line, result('2026-11-20T10:20:01.000Z', refused.id, [{ type: 'text', text: '❌ WORKFLOW BREACH' }]),
    ]);
    expect(claims.map((c) => c.itemRef)).toEqual(['b2c3d4e5', FULL]);
  });

  it('an MCP leave-plan dry run (validate_progress with plan) claims nothing', () => {
    const plan = mcpCall('2026-11-20T10:00:00.000Z', 'mcp__agenfk__validate_progress', { itemId: FULL, plan: true });
    const { claims } = parse([plan.line, result('2026-11-20T10:00:01.000Z', plan.id, [{ type: 'text', text: 'Leaving X runs nothing.' }])]);
    expect(claims).toEqual([]);
  });

  it('a subagent\'s claims and turns carry its agentId; the parent\'s carry none', () => {
    const sub = { agentId: 'a87be613c9077dcae', isSidechain: true };
    const gk = call('2026-11-20T10:00:00.000Z', `agenfk gatekeeper --intent "x" --item-id ${FULL}`, sub);
    const { claims, events } = parse([gk.line, result('2026-11-20T10:00:01.000Z', gk.id, '✅ AUTHORIZED', false, sub)]);
    expect(claims).toEqual([{ sessionId: SESSION, agentId: 'a87be613c9077dcae', itemRef: FULL, at: '2026-11-20T10:00:00.000Z' }]);
    expect(events.map((e) => e.agentId)).toEqual(['a87be613c9077dcae']);

    const parent = call('2026-11-20T11:00:00.000Z', 'ls');
    expect(parse([parent.line]).events[0].agentId).toBeUndefined();
  });

  it('a call whose reply is in the next pass is claimed then: the pending call is in the saved state', () => {
    const gk = call('2026-11-20T10:00:00.000Z', `agenfk gatekeeper --intent "x" --item-id ${FULL}`);
    const first = parse([gk.line]);
    expect(first.claims).toEqual([]);
    const restored = JSON.parse(JSON.stringify(first.state ?? null));
    const second = parse([result('2026-11-20T10:00:09.000Z', gk.id, '✅ AUTHORIZED')], { state: restored });
    expect(second.claims).toEqual([{ sessionId: SESSION, agentId: '', itemRef: FULL, at: '2026-11-20T10:00:00.000Z' }]);
  });

  it('turns are still one per message without a context (callers that do not collect claims)', () => {
    const gk = call('2026-11-20T10:00:00.000Z', `agenfk verify ${FULL} --evidence x`);
    const events = parseClaudeCodeJsonl(gk.line + '\n', '/p/sess-1.jsonl', 0);
    expect(events).toHaveLength(1);
  });
});
