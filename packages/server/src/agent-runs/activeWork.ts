/**
 * Which card is this session's work about? (CGLAB-177)
 *
 * Not a guess. `GET /items?active=true` can return dozens of items across a
 * dozen projects, and server.ts already says why guessing is wrong in its
 * comment on POST /agent-runs: the orchestrator registers a run precisely
 * because it "establishes the session↔card link that heuristic attribution
 * cannot". Logging an agent's work against the wrong card is worse than
 * logging none.
 *
 * So we read an explicit note instead. Every `agenfk gatekeeper` call resolves
 * an item before any edit is permitted — that resolution is the signal, and
 * the CLI records it here for the run recorder to pick up.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * How long a note stays usable.
 *
 * Long enough to cover a working session with gaps in it, short enough that
 * opening the editor the next morning does not attach every tool call to
 * whatever card was last touched yesterday.
 */
export const ACTIVE_WORK_TTL_MS = 4 * 60 * 60 * 1000;

/** Tolerance for a note stamped slightly ahead of us by clock skew. */
const FUTURE_TOLERANCE_MS = 60 * 1000;

export interface ActiveWork {
  itemId: string;
  projectId?: string;
}

export interface FileReader {
  read(): string;
}

export const activeWorkPath = (): string =>
  path.join(os.homedir(), '.agenfk', 'active-work.json');

const realReader: FileReader = {
  read: () => fs.readFileSync(activeWorkPath(), 'utf8'),
};

/** Serialize a note, stamped so its age can be judged later. */
export function serializeActiveWork(work: ActiveWork): string {
  return JSON.stringify({ ...work, at: new Date().toISOString() });
}

/**
 * The item the workflow last authorized, or null when there isn't a current
 * one. Null is the safe answer everywhere: missing note, corrupt note, no
 * timestamp, or a timestamp old enough to be about a different sitting.
 */
export function readActiveWork(reader: FileReader = realReader): ActiveWork | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reader.read());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const note = parsed as Record<string, unknown>;
  if (typeof note.itemId !== 'string' || !note.itemId) return null;

  // No timestamp means no way to know the note is current, and "probably
  // fine" is exactly how work ends up logged against the wrong card.
  if (typeof note.at !== 'string') return null;
  const at = Date.parse(note.at);
  if (!Number.isFinite(at)) return null;

  const age = Date.now() - at;
  if (age > ACTIVE_WORK_TTL_MS) return null;
  if (age < -FUTURE_TOLERANCE_MS) return null;

  return {
    itemId: note.itemId,
    projectId: typeof note.projectId === 'string' ? note.projectId : undefined,
  };
}

/** Record the item the gatekeeper just authorized. Never throws. */
export function writeActiveWork(work: ActiveWork): void {
  try {
    const target = activeWorkPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeActiveWork(work), 'utf8');
  } catch {
    // A lost note costs a run that is not recorded — never a failed command.
  }
}
