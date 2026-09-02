import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireSession } from '../auth/session.js';
import { recomputeRollups } from '../rollup.js';
import { aggregateHistogramRows } from '../queries/histogram-aggregate.js';
import { coerceMetricsRow } from '../queries/metrics-coerce.js';
import { aggregatePrOverview, PrEventRow } from '../queries/pr-overview-aggregate.js';
import { sanitizeRemoteUrl } from './events.js';
import { rateLimit } from '../util/rateLimit.js';
import { loadModelMappings } from '../util/modelMapping.js';

function parseList(s: string | undefined): string[] | null {
  // Repeated params (?model=a&model=b) arrive as an array — normalize to the
  // CSV form instead of letting .split throw a 500 (all list filters use this).
  if (Array.isArray(s)) s = s.join(',');
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
  // remote_url is stored in its canonical ssh form post-fix; canonicalise the
  // query input the same way so saved selections (https / no-.git / mixed
  // case) still resolve correctly.
  if (f.projects)  { where.push(`remote_url IN (${f.projects.map(() => '?').join(',')})`); params.push(...f.projects.map(s => sanitizeRemoteUrl(s))); }
  if (f.itemTypes) { where.push(`item_type IN (${f.itemTypes.map(() => '?').join(',')})`); params.push(...f.itemTypes); }
  if (f.from)      { where.push(`${timeCol} >= ?`); params.push(f.from); }
  if (f.to)        { where.push(`${timeCol} <= ?`); params.push(f.to); }
  return { where, params };
}

export function queriesRouter(ctx: HubServerContext): Router {
  const router = Router();

  // Authenticated and org-scoped, but every route here runs real SQL, so an
  // authenticated client in a loop is still a resource concern. Generous cap:
  // high enough that no legitimate dashboard hits it, low enough to bound abuse.
  router.use(rateLimit({ windowMs: 60 * 1000, max: 300, message: 'Too many requests, slow down.' }));
  const guard = requireSession(ctx.config.sessionSecret);

  router.get('/users', guard, async (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const { where, params } = applyEventFilters(req.session!.orgId, { ...f, users: null });
    const rows = await ctx.db.all(
      `SELECT user_key,
              MAX(occurred_at) AS last_seen,
              COUNT(*) AS events_count
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY user_key
       ORDER BY last_seen DESC`,
      params,
    );
    res.json(rows);
  });

  router.get('/timeline', guard, async (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const limit = Math.min(Number.parseInt((req.query.limit as string) ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt((req.query.offset as string) ?? '0', 10) || 0, 0);
    const { where, params } = applyEventFilters(req.session!.orgId, f);

    const rows = await ctx.db.all<any>(
      `SELECT event_id, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, item_title, external_id, user_key, reporting_version, payload
       FROM events WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    res.json({
      events: rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })),
      limit, offset,
    });
  });

  router.get('/metrics', guard, async (req: Request, res: Response) => {
    await recomputeRollups(ctx.db);
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;

    if (f.projects || f.itemTypes) {
      const { where, params } = applyEventFilters(orgId, f);
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT user_key, date(occurred_at) AS day,
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
         FROM events WHERE ${where.join(' AND ')}
         GROUP BY user_key, day
         ORDER BY day ASC, user_key ASC`,
        params,
      );
      res.json({ bucket: 'day', series: rows.map(coerceMetricsRow) });
      return;
    }

    const { where, params } = applyEventFilters(orgId, f, 'day');
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT user_key, day, events_count, items_closed, tokens_in, tokens_out, validate_passes, validate_fails, prs_opened
       FROM rollups_daily WHERE ${where.join(' AND ')}
       ORDER BY day ASC, user_key ASC`,
      params,
    );
    res.json({ bucket: 'day', series: rows.map(coerceMetricsRow) });
  });

  router.get('/event-types', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<{ type: string }>(
      `SELECT DISTINCT type FROM events WHERE org_id = ? ORDER BY type ASC`,
      [req.session!.orgId],
    );
    res.json({ types: rows.map(r => r.type) });
  });

  router.get('/projects', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<{ remote_url: string }>(
      `SELECT DISTINCT remote_url FROM events
       WHERE org_id = ? AND remote_url IS NOT NULL AND remote_url != ''
       ORDER BY remote_url ASC`,
      [req.session!.orgId],
    );
    res.json({ projects: rows.map(r => r.remote_url) });
  });

  router.get('/item-types', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;

    // The list of all known item types stays org-wide so chips remain
    // selectable even when the current filter set produces zero hits.
    const allRows = await ctx.db.all<{ item_type: string }>(
      `SELECT DISTINCT item_type FROM events
       WHERE org_id = ? AND item_type IS NOT NULL AND item_type != ''
       ORDER BY item_type ASC`,
      [orgId],
    );

    // Counts respect projects + event-type filters but ignore the itemTypes
    // filter — the UI uses these to show "what would I get if I selected
    // this chip", which is meaningless if we constrain by current selection.
    const f = readEventFilters(req);
    const { where, params } = applyEventFilters(orgId, { ...f, itemTypes: null });
    const countRows = await ctx.db.all<{ item_type: string; n: number }>(
      `SELECT item_type, COUNT(*) AS n FROM events
       WHERE ${where.join(' AND ')} AND item_type IS NOT NULL AND item_type != ''
       GROUP BY item_type`,
      params,
    );
    const counts: Record<string, number> = {};
    for (const r of countRows) counts[r.item_type] = Number(r.n);

    res.json({ itemTypes: allRows.map(r => r.item_type), counts });
  });

  router.get('/histogram', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const bucket = (req.query.bucket as string | undefined) ?? 'day';
    if (bucket !== 'day' && bucket !== 'hour') {
      res.status(400).json({ error: "bucket must be 'day' or 'hour'" });
      return;
    }
    const tzRaw = req.query.tzOffsetMin;
    const tzOffsetMin = typeof tzRaw === 'string' ? Number.parseInt(tzRaw, 10) : NaN;
    const tzShift = Number.isFinite(tzOffsetMin)
      ? Math.max(-14 * 60, Math.min(14 * 60, tzOffsetMin))
      : 0;
    const f = readEventFilters(req);
    const { where, params } = applyEventFilters(orgId, f);

    const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00';
    const tzModifier = tzShift !== 0 ? `, ?` : '';
    const sqlParams: any[] = [];
    if (tzShift !== 0) sqlParams.push(`${tzShift >= 0 ? '+' : ''}${tzShift} minutes`);
    sqlParams.push(...params);
    const rows = await ctx.db.all<{ time: string; type: string; n: number | string }>(
      `SELECT strftime('${fmt}', occurred_at${tzModifier}) AS time, type, COUNT(*) AS n
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY time, type
       ORDER BY time ASC`,
      sqlParams,
    );

    res.json({ bucket, buckets: aggregateHistogramRows(rows) });
  });

  // PR Overview: total PRs per developer per size (XS–XL, derived from leaf
  // items), per period, total + daily, with a model breakdown/filter. pr.updated
  // re-sizes the same PR (counted once, at its latest sizing, attributed to the
  // opener).
  router.get('/prs/overview', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const f = readEventFilters(req);
    // Multi-select: a CSV of models, same parseList semantics as users/projects.
    // A single-value ?model=x link keeps working (one-element list).
    const models = parseList(req.query.model as string | undefined);
    // Admin alias -> canonical. Resolved inside the aggregator for the rows, and
    // the filter values go through the same mapping so a saved link to
    // `?model=qwen38-27b` still finds the group now filed under `qwen3.8:27b`.
    const modelMapping = await loadModelMappings(ctx.db, orgId);

    // Fetch PR events with only the UPPER time bound applied in SQL (`upTo`). The
    // lower bound (`from`) and the model filter are intentionally NOT pushed down:
    // the aggregator needs each PR's true opener to decide window membership and
    // attribution, and a PR re-sized by a different runtime must still be matched
    // by its OPENER's model — pushing model into SQL would fetch only the matching
    // event and corrupt the opener. When `upTo` is null (open-ended), all events
    // are read so "latest sizing wins" reflects every re-size.
    // users (developer) filter is opener-based, applied in the aggregator — not
    // pushed to SQL, for the same reason as model: filtering events by user_key
    // would hide the opener of a PR re-sized by someone else and misattribute it.
    const fetchRows = async (upTo: string | null): Promise<PrEventRow[]> => {
      const base = applyEventFilters(orgId, { ...f, types: null, itemTypes: null, users: null, from: null, to: upTo });
      const where = [...base.where, `type IN ('pr.opened', 'pr.updated')`];
      return ctx.db.all<PrEventRow>(
        `SELECT user_key, occurred_at, type,
                json_extract(payload, '$.payload.repo') AS repo,
                json_extract(payload, '$.payload.prNumber') AS pr_number,
                json_extract(payload, '$.payload.leafStory') AS leaf_story,
                json_extract(payload, '$.payload.sizingShadow.task') AS task,
                json_extract(payload, '$.payload.sizingShadow.bug') AS bug,
                json_extract(payload, '$.payload.model') AS model,
                json_extract(payload, '$.payload.harness') AS harness
         FROM events WHERE ${where.join(' AND ')}
         ORDER BY occurred_at ASC`,
        base.params,
      );
    };

    const result = aggregatePrOverview(await fetchRows(f.to), { from: f.from, to: f.to, models, developers: f.users, modelMapping });

    // Previous equal-length window for deltas — only when a lower bound is set.
    // The previous window's upper bound is EXCLUSIVE of `from` so a PR opened
    // exactly at `from` is counted in the current window only, never both.
    let previous: { prs: number; sizePoints: number } | null = null;
    if (f.from) {
      const toMs = (f.to ? new Date(f.to) : new Date()).getTime();
      const fromMs = new Date(f.from).getTime();
      if (Number.isFinite(toMs) && Number.isFinite(fromMs) && toMs > fromMs) {
        const span = toMs - fromMs;
        const prevFrom = new Date(fromMs - span).toISOString();
        const prevTo = new Date(fromMs - 1).toISOString();
        const prev = aggregatePrOverview(await fetchRows(prevTo), { from: prevFrom, to: prevTo, models, developers: f.users, modelMapping });
        previous = { prs: prev.totals.prs, sizePoints: prev.totals.sizePoints };
      }
    }

    res.json({ period: { from: f.from, to: f.to }, ...result, previous });
  });

  return router;
}
