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

export function writeActiveWork(task: { id: string; projectId?: string }): void {
  try {
    const target = path.join(os.homedir(), '.agenfk', 'active-work.json');
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
