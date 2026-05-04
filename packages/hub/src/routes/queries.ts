import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireSession } from '../auth/session.js';
import { recomputeRollups } from '../rollup.js';

function parseList(s: string | undefined): string[] | null {
  if (!s) return null;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

interface EventFilters {
  users: string[] | null;
  types: string[] | null;
  projects: string[] | null;
  itemTypes: string[] | null;
  from: string | null;
  to: string | null;
}

function readEventFilters(req: Request): EventFilters {
  return {
    users: parseList(req.query.users as string | undefined),
    types: parseList(req.query.types as string | undefined),
    projects: parseList(req.query.projects as string | undefined),
    itemTypes: parseList(req.query.itemTypes as string | undefined),
    from: (req.query.from as string | undefined) ?? null,
    to: (req.query.to as string | undefined) ?? null,
  };
}

function applyEventFilters(orgId: string, f: EventFilters, timeCol: 'occurred_at' | 'day' = 'occurred_at')
  : { where: string[]; params: any[] } {
  const where: string[] = ['org_id = ?'];
  const params: any[] = [orgId];
  if (f.users)     { where.push(`user_key IN (${f.users.map(() => '?').join(',')})`);   params.push(...f.users); }
  if (f.types)     { where.push(`type IN (${f.types.map(() => '?').join(',')})`);       params.push(...f.types); }
  if (f.projects)  { where.push(`remote_url IN (${f.projects.map(() => '?').join(',')})`); params.push(...f.projects); }
  if (f.itemTypes) { where.push(`item_type IN (${f.itemTypes.map(() => '?').join(',')})`); params.push(...f.itemTypes); }
  if (f.from)      { where.push(`${timeCol} >= ?`); params.push(f.from); }
  if (f.to)        { where.push(`${timeCol} <= ?`); params.push(f.to); }
  return { where, params };
}

export function queriesRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireSession(ctx.config.sessionSecret);

  // Distinct event-actor users (for chip multi-select). Honours project /
  // item-type filters so the user list shrinks when a developer narrows scope.
  router.get('/users', guard, (req: Request, res: Response) => {
    const f = readEventFilters(req);
    // user_key filter doesn't make sense here — it's the field we're returning.
    const { where, params } = applyEventFilters(req.session!.orgId, { ...f, users: null });
    const rows = ctx.db.prepare(
      `SELECT user_key,
              MAX(occurred_at) AS last_seen,
              COUNT(*) AS events_count
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY user_key
       ORDER BY last_seen DESC`
    ).all(...params);
    res.json(rows);
  });

  // Paginated event timeline.
  router.get('/timeline', guard, (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const limit = Math.min(Number.parseInt((req.query.limit as string) ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt((req.query.offset as string) ?? '0', 10) || 0, 0);
    const { where, params } = applyEventFilters(req.session!.orgId, f);

    const rows = ctx.db.prepare(
      `SELECT event_id, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, user_key, payload
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
  // Project / item-type filters fall through to the events table because the
  // daily rollup intentionally aggregates across them.
  router.get('/metrics', guard, (req: Request, res: Response) => {
    recomputeRollups(ctx.db);
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;

    if (f.projects || f.itemTypes) {
      // Compute the same shape on-the-fly from the events table when the
      // caller is asking for a slice the rollup table doesn't pre-aggregate.
      const { where, params } = applyEventFilters(orgId, f);
      const rows = ctx.db.prepare(
        `SELECT user_key, date(occurred_at) AS day,
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
         FROM events WHERE ${where.join(' AND ')}
         GROUP BY user_key, day
         ORDER BY day ASC, user_key ASC`
      ).all(...params);
      res.json({ bucket: 'day', series: rows });
      return;
    }

    const { where, params } = applyEventFilters(orgId, f, 'day');
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

  // Distinct git remote URLs observed in this org. The agenfk client uses the
  // remote URL as a stable cross-installation "project" key — projectId itself
  // is per-user so it can't group activity from two devs on the same repo.
  router.get('/projects', guard, (req: Request, res: Response) => {
    const rows = ctx.db.prepare(
      `SELECT DISTINCT remote_url FROM events
       WHERE org_id = ? AND remote_url IS NOT NULL AND remote_url != ''
       ORDER BY remote_url ASC`
    ).all(req.session!.orgId) as Array<{ remote_url: string }>;
    res.json({ projects: rows.map(r => r.remote_url) });
  });

  // Distinct EPIC/STORY/TASK/BUG values observed (for the item-type chip row).
  router.get('/item-types', guard, (req: Request, res: Response) => {
    const rows = ctx.db.prepare(
      `SELECT DISTINCT item_type FROM events
       WHERE org_id = ? AND item_type IS NOT NULL AND item_type != ''
       ORDER BY item_type ASC`
    ).all(req.session!.orgId) as Array<{ item_type: string }>;
    res.json({ itemTypes: rows.map(r => r.item_type) });
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
    const f = readEventFilters(req);
    const { where, params } = applyEventFilters(orgId, f);

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
