import { DB } from './db.js';

export interface RecomputeOptions {
  /** Recompute every event-day on or after this 'YYYY-MM-DD', ignoring the anchor. */
  since?: string;
  /** Recompute the entire history. Wins over `since`. */
  full?: boolean;
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
  const days = from
    ? await db.all<{ day: string }>(
      `SELECT DISTINCT date(occurred_at) AS day
       FROM events
       WHERE date(occurred_at) >= ?
       ORDER BY day ASC`,
      [from],
    )
    : await db.all<{ day: string }>(
      `SELECT DISTINCT date(occurred_at) AS day
       FROM events
       ORDER BY day ASC`,
    );
  if (days.length === 0) return { days: 0 };

  const upsertSql = `
    INSERT INTO rollups_daily (org_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened)
    SELECT
      org_id,
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
      SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS prs_opened
    FROM events
    WHERE date(occurred_at) = ?
    GROUP BY org_id, user_key, date(occurred_at)
    ON CONFLICT(org_id, user_key, day) DO UPDATE SET
      events_count = excluded.events_count,
      items_closed = excluded.items_closed,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      validate_passes = excluded.validate_passes,
      validate_fails = excluded.validate_fails,
      prs_opened = excluded.prs_opened
  `;

  await db.transaction(async () => {
    for (const { day } of days) {
      await db.run(upsertSql, [day]);
    }
  });
  return { days: days.length };
}

export function startRollupTimer(db: DB, intervalMs: number = 5 * 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    recomputeRollups(db).catch((e) => console.error('[ROLLUP]', (e as Error).message));
  }, intervalMs);
  t.unref?.();
  return t;
}
