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

/**
 * Where the note lives.
 *
 * Keyed by session (CGLAB-570), because a single shared file collides across
 * concurrent sessions: this repo explicitly supports parallel agents on
 * different cards, and an unkeyed note let session A's first tool call open a
 * run against session B's card for the whole TTL. The gatekeeper now plumbs
 * the harness session id, so the KEYED note is the common path. The shared
 * file remains only for a sessionless reader — a harness that exposes no
 * session id at all — never as a fallback for a session whose keyed note is
 * missing: that fallback is precisely the misattribution this file exists to
 * prevent.
 */
export const activeWorkPath = (sessionId?: string): string => {
  const dir = path.join(os.homedir(), '.agenfk');
  return sessionId
    ? path.join(dir, 'active-work', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    : path.join(dir, 'active-work.json');
};

const readerFor = (sessionId?: string): FileReader => ({
  read: () => {
    // STRICT when a session is known (CGLAB-570): a missing keyed note means
    // no note — never the shared one. Falling back here is how one session's
    // card captured every other session's tool calls for the TTL; a run on
    // the wrong card is worse than no run, which is the rule this recorder
    // lives by. The shared file is read only when there is NO session id —
    // a harness that cannot name its session is the one case it is safe for.
    if (sessionId) return fs.readFileSync(activeWorkPath(sessionId), 'utf8');
    return fs.readFileSync(activeWorkPath(), 'utf8');
  },
});

/** Serialize a note, stamped so its age can be judged later. */
export function serializeActiveWork(work: ActiveWork): string {
  return JSON.stringify({ ...work, at: new Date().toISOString() });
}

/**
 * The item the workflow last authorized, or null when there isn't a current
 * one. Null is the safe answer everywhere: missing note, corrupt note, no
 * timestamp, or a timestamp old enough to be about a different sitting.
 */
export function readActiveWork(reader: FileReader = readerFor()): ActiveWork | null {
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

/** Read the note for a specific session, falling back to the shared one. */
export function readActiveWorkForSession(sessionId?: string): ActiveWork | null {
  return readActiveWork(readerFor(sessionId));
}

/** Record the item the gatekeeper just authorized. Never throws. */
export function writeActiveWork(work: ActiveWork, sessionId?: string): void {
  try {
    const target = activeWorkPath(sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeActiveWork(work), 'utf8');
  } catch {
    // A lost note costs a run that is not recorded — never a failed command.
  }
}
