import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireSession } from '../auth/session.js';
import { recomputeRollups } from '../rollup.js';

function parseList(s: string | undefined): string[] | null {
  if (!s) return null;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

export function queriesRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireSession(ctx.config.sessionSecret);

  // Distinct event-actor users (for chip multi-select).
  router.get('/users', guard, (req: Request, res: Response) => {
    const rows = ctx.db.prepare(`
      SELECT user_key,
             MAX(occurred_at) AS last_seen,
             COUNT(*) AS events_count
      FROM events WHERE org_id = ?
      GROUP BY user_key
      ORDER BY last_seen DESC
    `).all(req.session!.orgId);
    res.json(rows);
  });

  // Paginated event timeline.
  router.get('/timeline', guard, (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const users = parseList(req.query.users as string | undefined);
    const types = parseList(req.query.types as string | undefined);
    const from = (req.query.from as string | undefined) ?? null;
    const to = (req.query.to as string | undefined) ?? null;
    const limit = Math.min(Number.parseInt((req.query.limit as string) ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt((req.query.offset as string) ?? '0', 10) || 0, 0);

    const where: string[] = ['org_id = ?'];
    const params: any[] = [orgId];
    if (users) { where.push(`user_key IN (${users.map(() => '?').join(',')})`); params.push(...users); }
    if (types) { where.push(`type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    if (from) { where.push('occurred_at >= ?'); params.push(from); }
    if (to) { where.push('occurred_at <= ?'); params.push(to); }

    const rows = ctx.db.prepare(
      `SELECT event_id, occurred_at, received_at, type, project_id, item_id, user_key, payload
       FROM events WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      events: rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })),
      limit, offset,
    });
  });

  // Time-bucketed metrics from rollups_daily. v1 supports bucket=day only.
  router.get('/metrics', guard, (req: Request, res: Response) => {
    // Refresh rollups on read so fresh-write data shows up without waiting for the timer.
    recomputeRollups(ctx.db);
    const orgId = req.session!.orgId;
    const users = parseList(req.query.users as string | undefined);
    const from = (req.query.from as string | undefined) ?? null;
    const to = (req.query.to as string | undefined) ?? null;

    const where: string[] = ['org_id = ?'];
    const params: any[] = [orgId];
    if (users) { where.push(`user_key IN (${users.map(() => '?').join(',')})`); params.push(...users); }
    if (from) { where.push('day >= ?'); params.push(from); }
    if (to) { where.push('day <= ?'); params.push(to); }

    const rows = ctx.db.prepare(
      `SELECT user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails
       FROM rollups_daily WHERE ${where.join(' AND ')}
       ORDER BY day ASC, user_key ASC`
    ).all(...params);
    res.json({ bucket: 'day', series: rows });
  });

  // Distinct event types observed in this org — used to populate filter chips.
  router.get('/event-types', guard, (req: Request, res: Response) => {
    const rows = ctx.db.prepare(
      `SELECT DISTINCT type FROM events WHERE org_id = ? ORDER BY type ASC`
    ).all(req.session!.orgId) as Array<{ type: string }>;
    res.json({ types: rows.map(r => r.type) });
  });

  // Time-bucketed event histogram. Bars on the timeline UI consume this.
  // Returns one row per time bucket with per-type counts and total.
  router.get('/histogram', guard, (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const bucket = (req.query.bucket as string | undefined) ?? 'day';
    if (bucket !== 'day' && bucket !== 'hour') {
      res.status(400).json({ error: "bucket must be 'day' or 'hour'" });
      return;
    }
    const users = parseList(req.query.users as string | undefined);
    const types = parseList(req.query.types as string | undefined);
    const from = (req.query.from as string | undefined) ?? null;
    const to = (req.query.to as string | undefined) ?? null;

    const where: string[] = ['org_id = ?'];
    const params: any[] = [orgId];
    if (users) { where.push(`user_key IN (${users.map(() => '?').join(',')})`); params.push(...users); }
    if (types) { where.push(`type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    if (from) { where.push('occurred_at >= ?'); params.push(from); }
    if (to) { where.push('occurred_at <= ?'); params.push(to); }

    const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00';
    const rows = ctx.db.prepare(
      `SELECT strftime('${fmt}', occurred_at) AS time, type, COUNT(*) AS n
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY time, type
       ORDER BY time ASC`
    ).all(...params) as Array<{ time: string; type: string; n: number }>;

    const byTime = new Map<string, { time: string; total: number; by_type: Record<string, number> }>();
    for (const r of rows) {
      let entry = byTime.get(r.time);
      if (!entry) {
        entry = { time: r.time, total: 0, by_type: {} };
        byTime.set(r.time, entry);
      }
      entry.by_type[r.type] = r.n;
      entry.total += r.n;
    }

    res.json({ bucket, buckets: [...byTime.values()] });
  });

  return router;
}
