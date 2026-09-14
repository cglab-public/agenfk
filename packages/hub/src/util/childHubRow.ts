/**
 * Shape a `child_hubs` row for the admin API (CGLAB-181).
 *
 * Extracted from the route because the two things it does are exactly the two
 * that differ by backend and cannot both be observed through pg-mem:
 *  - Postgres returns TIMESTAMPTZ columns as Date objects while SQLite returns
 *    strings, and the API must emit one shape;
 *  - `live` is derived from that timestamp, so it inherits the same hazard.
 */
export const CHILD_HUB_LIVE_WINDOW_HOURS = 24;

export interface ChildHubDbRow {
  id: string;
  name: string;
  hub_version?: string | null;
  first_seen?: string | Date | null;
  last_seen?: string | Date | null;
  detached_at?: string | Date | null;
}

export interface ChildHubDto {
  id: string;
  name: string;
  hubVersion: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  live: boolean;
  detached: boolean;
  detachedAt: string | null;
}

/** ISO-8601 for a value that may already be a string, a Date, or absent. */
export function isoOrNull(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toChildHubDto(row: ChildHubDbRow, now: number = Date.now()): ChildHubDto {
  const lastSeen = isoOrNull(row.last_seen);
  const detachedAt = isoOrNull(row.detached_at);
  return {
    id: row.id,
    name: row.name,
    hubVersion: row.hub_version ?? null,
    firstSeen: isoOrNull(row.first_seen),
    lastSeen,
    // A detached hub is never live, whatever its last heartbeat said.
    live: !detachedAt && !!lastSeen
      && new Date(lastSeen).getTime() >= now - CHILD_HUB_LIVE_WINDOW_HOURS * 3600_000,
    detached: !!detachedAt,
    detachedAt,
  };
}
