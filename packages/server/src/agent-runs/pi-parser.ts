/**
 * Parse a pi.dev session JSONL transcript into agent-run transcript events.
 *
 * pi appends one JSON object per line to ~/.pi/agent/sessions/<project>/<id>.jsonl.
 * Relevant shapes:
 *   { type: 'session', ... }                              — ignored
 *   { type: 'model_change', provider, modelId }           — ignored
 *   { type: 'message', message: { role: 'assistant',
 *       content: [ { type:'thinking', thinking },
 *                  { type:'text', text },
 *                  { type:'toolCall', name, arguments } ],
 *       usage: { totalTokens } } }
 *   { type: 'message', message: { role: 'toolResult',
 *       toolName, isError, content: [ { type:'text', text } ] } }
 *
 * Pure & deterministic: the same append-only file always yields the same event
 * sequence, so a whole-file re-parse + count-based slice is idempotent.
 */

export type ParsedLane = 'orchestrator' | 'worker' | 'reviewer';
export type ParsedKind = 'dispatch' | 'think' | 'tool' | 'result' | 'diff' | 'verdict' | 'note';

export interface ParsedRunEvent {
  lane: ParsedLane;
  kind: ParsedKind;
  tool?: string;
  text?: string;
  payload?: string;
  tokens?: number;
}

const MAX_TEXT = 600;

function truncate(s: string): string {
  const t = s.replace(/\s+$/g, '');
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
}

/** One-line human summary of a tool call from its arguments. */
function summarizeTool(name: string, args: any): string {
  if (!args || typeof args !== 'object') return name;
  if (typeof args.command === 'string') return args.command;          // bash
  if (typeof args.path === 'string') return args.path;                // read/write/edit
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.pattern === 'string') return args.pattern;          // grep/glob
  const keys = Object.keys(args);
  return keys.length ? `${keys[0]}=${String(args[keys[0]]).slice(0, 120)}` : name;
}

function collectText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function parsePiSessionJsonl(text: string): ParsedRunEvent[] {
  const events: ParsedRunEvent[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; } // skip partial/incomplete lines
    if (!obj || obj.type !== 'message' || !obj.message) continue;
    const msg = obj.message;

    if (msg.role === 'assistant') {
      // Prefer the turn's incremental output tokens; pi's `totalTokens` is the
      // cumulative context size and would massively overcount if summed.
      const turnTokens =
        msg.usage && Number.isFinite(msg.usage.output) ? msg.usage.output
          : (msg.usage && Number.isFinite(msg.usage.totalTokens) ? msg.usage.totalTokens : undefined);
      let tokenAttached = false;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        let ev: ParsedRunEvent | null = null;
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          ev = { lane: 'worker', kind: 'think', text: truncate(b.thinking) };
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          ev = { lane: 'worker', kind: 'note', text: truncate(b.text) };
        } else if (b.type === 'toolCall' && typeof b.name === 'string') {
          ev = {
            lane: 'worker', kind: 'tool', tool: b.name,
            text: truncate(summarizeTool(b.name, b.arguments)),
            payload: b.arguments !== undefined ? JSON.stringify(b.arguments) : undefined,
          };
        }
        if (ev) {
          if (turnTokens !== undefined && !tokenAttached) { ev.tokens = turnTokens; tokenAttached = true; }
          events.push(ev);
        }
      }
    } else if (msg.role === 'toolResult') {
      const body = collectText(msg.content);
      events.push({
        lane: 'worker', kind: 'result',
        tool: typeof msg.toolName === 'string' ? msg.toolName : undefined,
        text: truncate(body || (msg.isError ? 'error' : 'ok')),
        payload: JSON.stringify({ isError: !!msg.isError }),
      });
    }
  }
  return events;
}
