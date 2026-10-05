/**
 * CGLAB-457 — the sub-agent transcripts of a Claude Code session, as the
 * candidates for the reviewer's.
 *
 * When `agenfk review record` is refused over its transcript, the author needs
 * the path of the reviewer's log: `~/.claude/projects/<project>/<session>/
 * subagents/agent-<id>.jsonl`. This lists them, newest first, each with the
 * start of the prompt it was given, so the reviewer's is easy to tell from an
 * exploration run. It only lists: choosing one would let any read-only
 * sub-agent be recorded as the reviewer without having reviewed anything.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptCandidate {
  path: string;
  /** The first 80 characters of the first prompt the sub-agent was given. */
  prompt: string;
  /** When the file was last written. */
  mtime: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROMPT_CHARS = 80;

/** Enough of a transcript to hold its first record: the files can be tens of megabytes. */
const HEAD_BYTES = 64 * 1024;

function headOf(file: string): string {
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const fd = fs.openSync(file, 'r');
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0); } finally { fs.closeSync(fd); }
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
}

function firstPrompt(file: string): string {
  let text = '';
  try {
    const first = headOf(file).split('\n').find(l => l.trim());
    const content = first ? JSON.parse(first)?.message?.content : undefined;
    text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join(' ') : '';
  } catch {
    // A first record longer than the head is cut off and does not parse: take the prompt's start from the text.
    const m = /"content"\s*:\s*(?:"((?:[^"\\]|\\.)*)|\[\s*\{[^}]*?"text"\s*:\s*"((?:[^"\\]|\\.)*))/.exec(headOf(file));
    text = m ? (m[1] ?? m[2] ?? '').replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS);
}

/** The session's sub-agent transcripts under `<home>/.claude/projects`, newest first; empty when there are none. */
export function subagentTranscripts(home: string, sessionId: string): TranscriptCandidate[] {
  if (!SESSION_ID.test(sessionId)) return [];
  const projects = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try { dirs = fs.readdirSync(projects); } catch { return []; }
  const out: Array<TranscriptCandidate & { at: number }> = [];
  for (const project of dirs) {
    const dir = path.join(projects, project, sessionId, 'subagents');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^agent-.+\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      let at: number;
      try { at = fs.statSync(file).mtimeMs; } catch { continue; }
      out.push({ path: file, prompt: firstPrompt(file), mtime: new Date(at).toISOString(), at });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(c => ({ path: c.path, prompt: c.prompt, mtime: c.mtime }));
}
