import { DB } from './db.js';

export interface RecomputeOptions {
  /** Recompute every event-day on or after this 'YYYY-MM-DD', ignoring the anchor. */
  since?: string;
  /** Recompute the entire history. Wins over `days` and `since`. */
  full?: boolean;
  /**
   * Recompute exactly these 'YYYY-MM-DD' days. Wins over `since`. For ingest's
   * backdated repair (#223): a batch of old events touches a few past days, and
   * `since` would rescan every day from the oldest one up to today.
   */
  days?: string[];
  /**
   * Limit the repair to one org. Without it a single tenant's identity merge
   * recomputes every other tenant's days too — a large, tenant-crossing write
   * triggered by one org's admin.
   */
  orgId?: string;
}

/**
 * Recompute rollups_daily for any (org, day) that has events with
 * occurred_at on or after the latest rollup's day. Runs in a single
 * transaction; safe to call frequently.
 *
 * The default anchor is deliberately forward-only — drift only happens in the
 * active window, and scanning all history on a 5-minute timer would make
 * /v1/metrics latency grow with the dataset. But that also means a historical
 * day can never be repaired, which a user_key merge needs: it rewrites events
 * across the whole history, so every day before the anchor would keep its stale
 * per-person totals. `since` and `full` exist for those repair paths and should
 * not be used by the timer. (CGLAB-65.)
 */
export async function recomputeRollups(db: DB, opts: RecomputeOptions = {}): Promise<{ days: number }> {
  let from: string | null;
  if (opts.full) {
    from = null;
  } else if (opts.since) {
    from = opts.since;
  } else {
    // Recompute only days that can have drift: all event-days at or after the
    // latest rolled-up day.
    const latest = await db.get<{ day: string }>(`SELECT MAX(day) AS day FROM rollups_daily`);
    from = latest?.day ?? null;
  }
  const orgFilter = opts.orgId ? ' AND org_id = ?' : '';
  const orgParam = opts.orgId ? [opts.orgId] : [];
  const days = !opts.full && opts.days
    ? [...new Set(opts.days)].sort().map(day => ({ day }))
    : from
    ? await db.all<{ day: string }>(
      `SELECT DISTINCT date(occurred_at) AS day
       FROM events
       WHERE date(occurred_at) >= ?${orgFilter}
       ORDER BY day ASC`,
      [from, ...orgParam],
    )
    : await db.all<{ day: string }>(
      `SELECT DISTINCT date(occurred_at) AS day
       FROM events
       ${opts.orgId ? 'WHERE org_id = ?' : ''}
       ORDER BY day ASC`,
      orgParam,
    );
  if (days.length === 0) return { days: 0 };

  // child_hub_id: '' for this hub's own events, a child hub's id for anything
  // forwarded to it. COALESCE because the column is nullable on events, where
  // NULL and '' both mean "ours".
  //
  // NOTE: no inline `--` comments inside this SQL. The dialect translator
  // rewrites ? placeholders positionally and a line comment swallows the rest
  // of the statement on Postgres — which is how this same trap has bitten
  // before, and pg-mem is the only place it surfaces.
  const upsertSql = `
    INSERT INTO rollups_daily (org_id, child_hub_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened, transitions_judged, transitions_compliant)
    SELECT
      org_id,
      COALESCE(child_hub_id, '') AS child_hub_id,
      user_key,
      date(occurred_at) AS day,
      COUNT(*) AS events_count,
      COUNT(DISTINCT CASE
        WHEN type = 'item.closed' THEN item_id
        WHEN type = 'step.transitioned'
             AND json_extract(payload, '$.payload.toStatus') = 'DONE' THEN item_id
      END) AS items_closed,
      0 AS tokens_in,
      0 AS tokens_out,
      SUM(CASE WHEN type = 'validate.passed' THEN 1 ELSE 0 END) AS validate_passes,
      SUM(CASE WHEN type = 'validate.failed' THEN 1 ELSE 0 END) AS validate_fails,
      SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS prs_opened,
      SUM(CASE
        WHEN type = 'step.transitioned'
             AND json_extract(payload, '$.payload.flowRevision') IS NOT NULL THEN 1 ELSE 0
      END) AS transitions_judged,
      SUM(CASE
        WHEN type = 'step.transitioned'
             AND json_extract(payload, '$.payload.flowRevision') IS NOT NULL
             AND LOWER(json_extract(payload, '$.payload.compliant')) IN ('true', '1') THEN 1 ELSE 0
      END) AS transitions_compliant
    FROM events
    WHERE date(occurred_at) = ?${orgFilter}
    GROUP BY org_id, COALESCE(child_hub_id, ''), user_key, date(occurred_at)
    ON CONFLICT(org_id, child_hub_id, user_key, day) DO UPDATE SET
      events_count = excluded.events_count,
      items_closed = excluded.items_closed,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      validate_passes = excluded.validate_passes,
      validate_fails = excluded.validate_fails,
      prs_opened = excluded.prs_opened,
      transitions_judged = excluded.transitions_judged,
      transitions_compliant = excluded.transitions_compliant
  `;

  // One transaction PER DAY rather than one across the whole range. A
  // full-history repair would otherwise hold a write transaction open for the
  // entire scan, and on Postgres the adapter routes every concurrent statement
  // through the open transaction's client — so a failure late in the scan would
  // roll back unrelated ingest that happened during it. Per-day also means a
  // crash leaves earlier days already repaired.
  for (const { day } of days) {
    await db.transaction(async () => {
      await db.run(upsertSql, [day, ...orgParam]);
    });
  }
  return { days: days.length };
}

/**
 * The UTC calendar day of an event instant, as SQLite's date(occurred_at)
 * computes it for the rollups (an offset timestamp late in the evening belongs
 * to the next UTC day). Falls back to the leading date for an unparseable one.
 */
export function utcDayOf(occurredAt: string): string {
  // No offset means UTC to SQLite (and to Postgres' ::timestamptz on a UTC
  // hub); Date.parse would read it as the host's local time instead.
  const hasOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(occurredAt);
  const dateTime = /^\d{4}-\d{2}-\d{2}[T ]\d/.test(occurredAt);
  const t = Date.parse(hasOffset || !dateTime ? occurredAt : `${occurredAt.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? occurredAt.slice(0, 10) : new Date(t).toISOString().slice(0, 10);
}

/**
 * Roll up the days, among `days`, that fall before the latest rolled-up day —
 * the ones the forward-only timer will never revisit (#223). Days at or after
 * that anchor are the timer's. With no anchor yet, the timer's first run rolls
 * up the whole history, so there is nothing to do here either.
 *
 * The anchor is capped at today (UTC): occurredAt is client-supplied, and one
 * event dated in the future would otherwise push the global anchor ahead and
 * make every live batch from every tenant pay for a recompute of its own day.
 * Live traffic is today's, so it never triggers this; only genuinely backdated
 * events do.
 */
export async function recomputeBackdatedDays(db: DB, orgId: string, days: Iterable<string>): Promise<{ days: number }> {
  const candidates = [...new Set(days)];
  if (candidates.length === 0) return { days: 0 };
  const latest = (await db.get<{ day: string | null }>(`SELECT MAX(day) AS day FROM rollups_daily`))?.day ?? null;
  if (!latest) return { days: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const anchor = latest < today ? latest : today;
  const backdated = candidates.filter(d => d < anchor);
  if (backdated.length === 0) return { days: 0 };
  return recomputeRollups(db, { days: backdated, orgId });
}

export function startRollupTimer(db: DB, intervalMs: number = 5 * 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    recomputeRollups(db).catch((e) => console.error('[ROLLUP]', (e as Error).message));
  }, intervalMs);
  t.unref?.();
  return t;
}
