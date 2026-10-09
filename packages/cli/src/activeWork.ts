/**
 * Record which card the workflow just authorized (CGLAB-177).
 *
 * Lives in the CLI rather than importing from the server package so the
 * gatekeeper — which runs on every edit and must stay fast — pulls in nothing
 * beyond node builtins. The reader side, with its staleness rules, is in
 * packages/server/src/agent-runs/activeWork.ts.
 *
 * That independence is the point AND the hazard: two packages build the same
 * file and nothing made them agree. A drifted field name would not error
 * anywhere — the reader's validation would simply reject the note, the hook
 * would open no run, and the Runs panel would be empty. Both halves correct,
 * the feature dead.
 *
 * packages/server/src/test/active-work-roundtrip.test.ts closes that: it has
 * this writer write and that reader read, and requires the card that comes
 * back to be the card that went in. It is a round trip rather than a
 * comparison of field names, because two serializers can agree on names and
 * disagree on everything else.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where the note lives, keyed by session when one is known (CGLAB-570).
 *
 * The gatekeeper now receives the harness session id (Claude Code exposes
 * CLAUDE_CODE_SESSION_ID to Bash tool subprocesses; `--session` is the
 * explicit route), so a KEYED note is the common path and concurrent sessions
 * no longer capture each other's tool calls through one shared file. The
 * sanitisation MUST mirror the reader's in packages/server (activeWorkPath):
 * two packages hand-build this path and nothing makes them agree — the
 * round-trip test pins it.
 *
 * Deliberately independent of the server package so the gatekeeper — which
 * runs on every edit and must stay fast — pulls in nothing beyond builtins.
 */
export function activeWorkPath(sessionId?: string): string {
  const dir = path.join(os.homedir(), '.agenfk');
  return sessionId
    ? path.join(dir, 'active-work', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    : path.join(dir, 'active-work.json');
}

/**
 * Record which card the workflow just authorized.
 *
 * With a session id the note is KEYED to that session; without one it lands
 * in the shared file, which only a sessionless harness reads.
 */
export function writeActiveWork(task: { id: string; projectId?: string }, sessionId?: string): void {
  try {
    const target = activeWorkPath(sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify({ itemId: task.id, projectId: task.projectId, at: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    // A lost note costs an unrecorded run, never a failed gatekeeper check.
  }
}
