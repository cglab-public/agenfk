/**
 * @vitest-environment node
 *
 * CGLAB-570: two concurrent sessions, one gatekeeper call — the OTHER
 * session's tool calls must open no run.
 *
 * The old shape had the run recorder fall back to the SHARED note
 * (~/.agenfk/active-work.json) whenever the session's keyed note was absent,
 * so the last card authorized by ANY session on the machine captured every
 * other session's tool calls for the TTL (4h). The fix makes the keyed note
 * the common path — the gatekeeper plumbs the harness session id — and makes
 * the reader strict: with a session id, a missing keyed note means NO note,
 * never the shared one.
 *
 * This is the card's agreed test shape, at the two seams where a run is
 * opened: the writer (the real CLI gatekeeper note) and the reader the hook
 * consults before POSTing /agent-runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeActiveWork } from '../../../cli/src/activeWork';
import { readActiveWorkForSession, activeWorkPath } from '../agent-runs/activeWork';
import * as hook from '../../../../bin/agenfk-run-hook.mjs';

const ACTIVE_WORK_DIR = (): string => path.join(os.homedir(), '.agenfk', 'active-work');
const SHARED = activeWorkPath();

const wipe = (): void => {
  try { fs.rmSync(SHARED, { force: true }); } catch { /* nothing there */ }
  try { fs.rmSync(ACTIVE_WORK_DIR(), { recursive: true, force: true }); } catch { /* nothing there */ }
};

beforeEach(wipe);
afterEach(wipe);

describe('CGLAB-570: two concurrent sessions, one gatekeeper call', () => {
  it("the other session's tool calls open no run — its reader sees no note", () => {
    // Session A runs the gatekeeper once; session B never did.
    writeActiveWork({ id: 'item-42', projectId: 'proj-7' }, 'session-A');

    // Session B's tool call: the hook reads B's note. Strictly none — NOT the
    // note A wrote, and NOT a shared note from anyone else.
    expect(readActiveWorkForSession('session-B')).toBeNull();
  });

  it('the calling session still gets its own card', () => {
    writeActiveWork({ id: 'item-42', projectId: 'proj-7' }, 'session-A');
    const read = readActiveWorkForSession('session-A');
    expect(read?.itemId).toBe('item-42');
    expect(read?.projectId).toBe('proj-7');
  });

  it('no run even when a STALE shared note from an older writer exists', () => {
    // Machines upgrading from the shared-only writer still have the old file
    // lying around. It must not capture keyed sessions' runs.
    fs.mkdirSync(path.dirname(SHARED), { recursive: true });
    fs.writeFileSync(SHARED, JSON.stringify({ itemId: 'legacy-item', projectId: 'p', at: new Date().toISOString() }), 'utf8');
    writeActiveWork({ id: 'item-42', projectId: 'proj-7' }, 'session-A');
    expect(readActiveWorkForSession('session-B')).toBeNull();
    // And a session that has no note of its own must not adopt the shared one either.
    expect(readActiveWorkForSession('session-C')).toBeNull();
  });

  it('a hook payload without a session id keeps reading the shared note', () => {
    // The fallback is for writers/readers with NO session at all, not for
    // sessions whose note is missing.
    fs.mkdirSync(path.dirname(SHARED), { recursive: true });
    fs.writeFileSync(SHARED, JSON.stringify({ itemId: 'shared-item', projectId: 'p', at: new Date().toISOString() }), 'utf8');
    expect(readActiveWorkForSession(undefined)?.itemId).toBe('shared-item');
  });
});

describe('the gatekeeper writes where the keyed reader looks', () => {
  it('round-trips through the session-keyed path, including unsafe session ids', () => {
    // The session id is harness-controlled; the path must sanitise it the way
    // the reader does or the two halves silently disagree.
    const sessionId = 'abc/../123 with spaces';
    writeActiveWork({ id: 'item-42', projectId: 'proj-7' }, sessionId);
    expect(fs.existsSync(activeWorkPath(sessionId))).toBe(true);
    expect(readActiveWorkForSession(sessionId)?.itemId).toBe('item-42');
    expect(fs.existsSync(activeWorkPath())).toBe(false);
  });
});

describe('the hook refuses to open a run on another session\u2019s note', () => {
  const { activeItem } = hook as any;
  const readerFor = (note: unknown) => () => JSON.stringify(note);

  it('returns null for a session whose note names no item', async () => {
    expect(await activeItem(readerFor({}), 'session-B', 'proj-7')).toBeNull();
  });

  it('returns null when the note is missing entirely — no run, not a fallback', async () => {
    // The dist reader surfaces a missing file as an unparseable empty read;
    // activeItem must treat that as "no note", never fall back.
    const strictReader = (): string => '';
    expect(await activeItem(strictReader, 'session-B', 'proj-7')).toBeNull();
  });
});
