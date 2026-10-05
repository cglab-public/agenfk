/**
 * @file CGLAB-457 (T1) — which sub-agent transcripts could be the reviewer's.
 *
 * When `agenfk review record` is refused over its transcript, the CLI lists
 * this session's sub-agent logs (newest first, each with the start of the
 * prompt it was given) so the author can pick the reviewer's. It only LISTS:
 * picking one itself would let any read-only sub-agent - an exploration run,
 * say - be recorded as the reviewer without having reviewed anything.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { subagentTranscripts } from '../reviewTranscripts';

const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
function homeWith(session: string, agents: Array<{ id: string; prompt: unknown; mtime: number }>, project = '-repo'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rtx-'));
  cleanup.push(home);
  const dir = path.join(home, '.claude', 'projects', project, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const a of agents) {
    const f = path.join(dir, `agent-${a.id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'user', isSidechain: true, agentId: a.id, sessionId: session, message: { role: 'user', content: a.prompt } }));
    fs.utimesSync(f, new Date(a.mtime), new Date(a.mtime));
  }
  return home;
}

describe('subagentTranscripts', () => {
  it("lists the session's sub-agent transcripts newest first, with the start of each one's prompt", () => {
    const home = homeWith('sess-1', [
      { id: 'old', prompt: 'Explore the repository layout', mtime: 1_000_000 },
      { id: 'new', prompt: 'You are an independent reviewer. Review the range 1a2b..HEAD', mtime: 2_000_000 },
    ]);
    const got = subagentTranscripts(home, 'sess-1');
    expect(got.map(c => path.basename(c.path))).toEqual(['agent-new.jsonl', 'agent-old.jsonl']);
    expect(got[0].prompt).toMatch(/^You are an independent reviewer/);
    expect(got[0].prompt.length).toBeLessThanOrEqual(80);
  });

  it('reads a prompt given as content blocks', () => {
    const home = homeWith('sess-2', [{ id: 'b', prompt: [{ type: 'text', text: 'Review this diff' }], mtime: 1_000_000 }]);
    expect(subagentTranscripts(home, 'sess-2')[0].prompt).toBe('Review this diff');
  });

  it("finds the session under whichever project folder holds it, and ignores other sessions'", () => {
    const home = homeWith('sess-3', [{ id: 'mine', prompt: 'p', mtime: 1_000_000 }], '-some-other-project');
    const other = path.join(home, '.claude', 'projects', '-repo', 'sess-other', 'subagents');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'agent-theirs.jsonl'), line({ type: 'user', sessionId: 'sess-other' }));
    expect(subagentTranscripts(home, 'sess-3').map(c => path.basename(c.path))).toEqual(['agent-mine.jsonl']);
  });

  it('still shows the prompt of a first record too long to read whole (second review)', () => {
    const home = homeWith('sess-4', [{ id: 'long', prompt: 'You are an independent reviewer. ' + 'x'.repeat(100_000), mtime: 1_000_000 }]);
    expect(subagentTranscripts(home, 'sess-4')[0].prompt).toMatch(/^You are an independent reviewer\./);
  });

  it('is empty, not an error, when there is nothing to list', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rtx-empty-'));
    cleanup.push(home);
    expect(subagentTranscripts(home, 'nope')).toEqual([]);
    expect(subagentTranscripts(home, '../escape')).toEqual([]);
  });
});
