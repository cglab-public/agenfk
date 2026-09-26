/**
 * The board and the reviewer, as scenarios meet them: the Kanban board's
 * requests (the `x-agenfk-ui: 1` header), a software passkey enrolled once,
 * and a reviewer's session log where Claude Code writes one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, sh, HOME } from './lib.mjs';
import { write } from './cards.mjs';
import { softAuthenticator } from './authenticator.mjs';

export const board = (method, path, body) => api(method, path, body, { board: true });
export const AUTHOR = { client: 'claude-code', sessionId: 'author-session', agentId: null };

// ── The passkey ─────────────────────────────────────────────────────────────
const authenticator = softAuthenticator();
let enrolled = false;
export async function enroll() {
  if (enrolled) return;
  const { body: { challenge } } = await board('POST', '/webauthn/challenge', { purpose: 'enroll' });
  const r = await board('POST', '/webauthn/credentials', { registration: authenticator.register(challenge) });
  if (r.status !== 201) throw new Error(`enrolment refused (${r.status}): ${JSON.stringify(r.body)}`);
  enrolled = true;
}
/** A signature over exactly this act. */
export async function signed(act) {
  const { body: { challenge } } = await board('POST', '/webauthn/challenge', act);
  return authenticator.assert(challenge);
}

// ── Review transcripts ──────────────────────────────────────────────────────
let tseq = 0;
/**
 * A reviewer's session log where Claude Code writes one, timestamped now (after
 * the commits it reviews). `agentId` makes it a sub-agent of `sessionId`;
 * `tools` are tool calls it made.
 */
export function transcript({ sessionId = `reviewer-${++tseq}`, agentId = null, tools = [] } = {}) {
  const dir = join(HOME, '.claude', 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  const now = new Date(Date.now() + 1000).toISOString();
  const lines = [{ sessionId, timestamp: now, ...(agentId ? { isSidechain: true, agentId } : {}) }];
  for (const t of tools) lines.push({ sessionId, timestamp: now, message: { content: [{ type: 'tool_use', ...t }] } });
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  if (!agentId) { const f = join(dir, `${sessionId}.jsonl`); writeFileSync(f, text); return f; }
  writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ sessionId, timestamp: now }) + '\n');
  mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true });
  const f = join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  writeFileSync(f, text);
  return f;
}
export const token = () => sh(`cat ${join(HOME, '.agenfk', 'verify-token')}`);
/** Record a review the way `agenfk review record` does. */
export const record = (id, body) => api('POST', `/items/${id}/review-records`, { findings: [], ...body }, { headers: { 'x-agenfk-internal': token() } });
/** Some committed work on WORK, then the range from the card's start to it. */
export function commitWork(dir, n = 1) {
  write(dir, { [`src/work${n}.js`]: `export const w${n} = ${n};\n` });
  sh(`git add -A && git commit -qm work${n}`, dir);
  return sh('git rev-parse HEAD', dir);
}
export const firstCommit = dir => sh('git rev-list --max-parents=0 HEAD', dir);
