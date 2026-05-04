import { DB } from './db.js';

/**
 * Recompute rollups_daily for any (org, day) that has events with
 * occurred_at on or after the latest rollup's day. Runs in a single
 * transaction; safe to call frequently.
 */
export async function recomputeRollups(db: DB): Promise<{ days: number }> {
  const lastRow = await db.get<{ day: string | null }>('SELECT MAX(day) AS day FROM rollups_daily');
  const lastDay = lastRow?.day || '1970-01-01';
  const days = await db.all<{ day: string }>(
    `SELECT DISTINCT date(occurred_at) AS day FROM events WHERE date(occurred_at) >= ?`,
    [lastDay],
  );

  const upsertSql = `
    INSERT INTO rollups_daily (org_id, user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails)
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
      SUM(CASE WHEN type = 'tokens.logged'
               THEN COALESCE(CAST(json_extract(payload, '$.payload.tokenUsage[0].input') AS INTEGER), 0) ELSE 0 END) AS tokens_in,
      SUM(CASE WHEN type = 'tokens.logged'
               THEN COALESCE(CAST(json_extract(payload, '$.payload.tokenUsage[0].output') AS INTEGER), 0) ELSE 0 END) AS tokens_out,
      SUM(CASE WHEN type = 'validate.passed' THEN 1 ELSE 0 END) AS validate_passes,
      SUM(CASE WHEN type = 'validate.failed' THEN 1 ELSE 0 END) AS validate_fails
    FROM events
    WHERE date(occurred_at) = ?
    GROUP BY org_id, user_key, date(occurred_at)
    ON CONFLICT(org_id, user_key, day) DO UPDATE SET
      events_count = excluded.events_count,
      items_closed = excluded.items_closed,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      validate_passes = excluded.validate_passes,
      validate_fails = excluded.validate_fails
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
