/**
 * Record which card the workflow just authorized (CGLAB-177).
 *
 * Lives in the CLI rather than importing from the server package so the
 * gatekeeper — which runs on every edit and must stay fast — pulls in nothing
 * beyond node builtins. The reader side, with its staleness rules, is in
 * packages/server/src/agent-runs/activeWork.ts and is tested there.
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
