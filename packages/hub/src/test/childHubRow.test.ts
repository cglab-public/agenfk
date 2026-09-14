// Row shaping for the child-hub admin list (CGLAB-181).
//
// This exists because pg-mem hands back ISO strings while real Postgres hands
// back Date objects, so the parity suite cannot observe the normalisation it
// depends on. Asserting both shapes here is the only way to pin it.
import { describe, it, expect } from 'vitest';
import { toChildHubDto, isoOrNull, CHILD_HUB_LIVE_WINDOW_HOURS } from '../util/childHubRow';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const iso = '2026-09-14T10:00:00.000Z';

describe('toChildHubDto', () => {
  it('emits ISO strings whether the backend returned a string or a Date', () => {
    const asString = toChildHubDto({ id: 'c', name: 'n', last_seen: iso, first_seen: iso }, NOW);
    const asDate = toChildHubDto({ id: 'c', name: 'n', last_seen: new Date(iso), first_seen: new Date(iso) }, NOW);
    expect(asString.lastSeen).toBe(iso);
    expect(asDate.lastSeen).toBe(iso);
    expect(asDate).toEqual(asString);
  });

  it('derives live from the heartbeat window, for both row shapes', () => {
    const stale = new Date(NOW - (CHILD_HUB_LIVE_WINDOW_HOURS + 1) * 3600_000);
    const fresh = new Date(NOW - 60_000);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: fresh }, NOW).live).toBe(true);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: fresh.toISOString() }, NOW).live).toBe(true);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: stale }, NOW).live).toBe(false);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: stale.toISOString() }, NOW).live).toBe(false);
  });

  it('treats the window edge as still live, so a hub is not stale one tick early', () => {
    const edge = new Date(NOW - CHILD_HUB_LIVE_WINDOW_HOURS * 3600_000);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: edge }, NOW).live).toBe(true);
    expect(toChildHubDto({ id: 'c', name: 'n', last_seen: new Date(edge.getTime() - 1) }, NOW).live).toBe(false);
  });

  it('never calls a detached hub live, however recent its last heartbeat', () => {
    const d = toChildHubDto(
      { id: 'c', name: 'n', last_seen: new Date(NOW - 1000), detached_at: new Date(NOW) }, NOW,
    );
    expect(d.detached).toBe(true);
    expect(d.live).toBe(false);
    expect(d.detachedAt).toBe(new Date(NOW).toISOString());
  });

  it('survives missing and unparseable timestamps instead of emitting Invalid Date', () => {
    const none = toChildHubDto({ id: 'c', name: 'n' }, NOW);
    expect(none).toMatchObject({ lastSeen: null, firstSeen: null, live: false, detached: false, detachedAt: null });
    expect(isoOrNull('not a date')).toBeNull();
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
  });

  it('passes the version through and nulls a missing one', () => {
    expect(toChildHubDto({ id: 'c', name: 'n', hub_version: '1.1.19' }, NOW).hubVersion).toBe('1.1.19');
    expect(toChildHubDto({ id: 'c', name: 'n' }, NOW).hubVersion).toBeNull();
  });
});
