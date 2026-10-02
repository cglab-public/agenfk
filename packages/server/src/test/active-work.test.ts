/**
 * CGLAB-177: which card does a recorded run belong to?
 *
 * Guessing is not an option. On this machine `GET /items?active=true` returns
 * ninety items across a dozen projects, and `server.ts` says as much in its own
 * comment on POST /agent-runs: the orchestrator registers the run because it
 * "establishes the session↔card link that heuristic attribution cannot".
 * Attributing an agent's work to the wrong card is worse than recording none.
 *
 * So the hook does not guess. It reads a note the workflow already writes:
 * every `agenfk gatekeeper` call resolves an item before any edit is allowed,
 * and that resolution is the explicit signal. This file covers reading it —
 * and, above all, refusing to use it once it is old enough to be about
 * yesterday's work.
 */
import { describe, it, expect } from 'vitest';
import { readActiveWork, serializeActiveWork, ACTIVE_WORK_TTL_MS } from '../agent-runs/activeWork';

const at = (isoOffsetMs: number) => new Date(Date.now() - isoOffsetMs).toISOString();

const file = (contents: string | null) => ({
  read: () => {
    if (contents === null) throw new Error('ENOENT');
    return contents;
  },
});

describe('readActiveWork', () => {
  it('returns the item the gatekeeper last authorized', () => {
    const work = readActiveWork(file(serializeActiveWork({ itemId: 'i1', projectId: 'p1' })));
    expect(work?.itemId).toBe('i1');
    expect(work?.projectId).toBe('p1');
  });

  it('returns null when nothing has been authorized yet', () => {
    expect(readActiveWork(file(null))).toBeNull();
  });

  it('returns null for a corrupt note rather than throwing', () => {
    expect(readActiveWork(file('{not json'))).toBeNull();
    expect(readActiveWork(file('[]'))).toBeNull();
    expect(readActiveWork(file('"a string"'))).toBeNull();
  });

  it('returns null when the note has no itemId', () => {
    expect(readActiveWork(file(JSON.stringify({ at: at(0) })))).toBeNull();
  });

  it('accepts a note written moments ago', () => {
    expect(readActiveWork(file(JSON.stringify({ itemId: 'i1', at: at(1000) })))?.itemId).toBe('i1');
  });

  it('refuses a stale note — that work is from another sitting', () => {
    // Without this, opening the editor the next morning would attach every
    // tool call to whatever card was last touched yesterday.
    const stale = JSON.stringify({ itemId: 'i1', at: at(ACTIVE_WORK_TTL_MS + 60_000) });
    expect(readActiveWork(file(stale))).toBeNull();
  });

  it('refuses a note with an unparseable timestamp', () => {
    expect(readActiveWork(file(JSON.stringify({ itemId: 'i1', at: 'whenever' })))).toBeNull();
  });

  it('refuses a note with no timestamp at all', () => {
    // No timestamp means no way to know it is current, and "probably fine" is
    // how work gets logged against the wrong card.
    expect(readActiveWork(file(JSON.stringify({ itemId: 'i1' })))).toBeNull();
  });

  it('refuses a note dated in the future beyond clock-skew tolerance', () => {
    const future = JSON.stringify({ itemId: 'i1', at: new Date(Date.now() + 86_400_000).toISOString() });
    expect(readActiveWork(file(future))).toBeNull();
  });

  it('tolerates small clock skew rather than dropping the note', () => {
    const slightlyAhead = JSON.stringify({ itemId: 'i1', at: new Date(Date.now() + 5_000).toISOString() });
    expect(readActiveWork(file(slightlyAhead))?.itemId).toBe('i1');
  });
});

describe('serializeActiveWork', () => {
  it('stamps the note so staleness can be judged later', () => {
    const parsed = JSON.parse(serializeActiveWork({ itemId: 'i1', projectId: 'p1' }));
    expect(parsed.itemId).toBe('i1');
    expect(Number.isFinite(Date.parse(parsed.at))).toBe(true);
  });

  it('round-trips through readActiveWork', () => {
    const work = readActiveWork(file(serializeActiveWork({ itemId: 'i9' })));
    expect(work?.itemId).toBe('i9');
  });
});
