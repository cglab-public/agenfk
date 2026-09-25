import { Router, Request, Response, NextFunction } from 'express';
import { HubServerContext } from '../server.js';
import { requireSession } from '../auth/session.js';
import { recomputeRollups } from '../rollup.js';
import { aggregateHistogramRows } from '../queries/histogram-aggregate.js';
import { coerceMetricsRow } from '../queries/metrics-coerce.js';
import { aggregatePrOverview, parsePrNumberFilter, PrEventRow } from '../queries/pr-overview-aggregate.js';
import { sanitizeRemoteUrl } from './events.js';
import { rateLimit, sessionUserKey } from '../util/rateLimit.js';
import { loadModelMappings } from '../util/modelMapping.js';
import { loadModelMeta, resolveModelMetaAll } from '../util/modelMeta.js';
import { resolveModelId } from '../util/modelMapping.js';
import { childHubPredicate, childHubClause, selectedHubIds, HUB_COL_EVENTS, HUB_COL_ROLLUPS } from '../queries/childHub.js';
import { asyncRoute } from '../util/asyncRoute.js';

/**
 * A query parameter that is not the shape the route reads. Express parses
 * `?from=a&from=b` into an array and `?from[a]=b` into an object, so a value
 * cast to string is a claim, not a check (CodeQL #107). Answered with a 400 by
 * the router's error handler below.
 */
class BadQuery extends Error {}

/** A parameter that must be ONE value: absent, or a single string. */
function singleValue(req: Request, name: string): string | null {
  const v = req.query[name];
  if (v === undefined) return null;
  if (typeof v !== 'string') throw new BadQuery(`Query parameter '${name}' must be given once, as a single value.`);
  return v;
}

function parseList(req: Request, name: string): string[] | null {
  const v = req.query[name];
  if (v === undefined) return null;
  // Repeated params (?model=a&model=b) arrive as an array — merged into the
  // CSV form, which is what a list filter means. A nested object is not a list.
  let s: string;
  if (typeof v === 'string') s = v;
  else if (Array.isArray(v) && v.every(x => typeof x === 'string')) s = v.join(',');
  else throw new BadQuery(`Query parameter '${name}' must be a comma-separated list.`);
  if (!s) return null;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

interface EventFilters {
  users: string[] | null;
  types: string[] | null;
  projects: string[] | null;
  itemTypes: string[] | null;
  /**
   * Which hubs in the federation group to read. `null` means all of them,
   * which is the only thing a standalone hub ever sees. See LOCAL_HUB for the
   * reserved value that selects this hub's own events.
   */
  childHubs: string[] | null;
  from: string | null;
  to: string | null;
}

function readEventFilters(req: Request): EventFilters {
  return {
    users: parseList(req, 'users'),
    types: parseList(req, 'types'),
    projects: parseList(req, 'projects'),
    itemTypes: parseList(req, 'itemTypes'),
    childHubs: parseList(req, 'childHubId'),
    from: singleValue(req, 'from'),
    to: singleValue(req, 'to'),
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
  // timeCol already tells the two tables apart; the hub column follows it.
  const hub = childHubPredicate(f.childHubs, timeCol === 'day' ? HUB_COL_ROLLUPS : HUB_COL_EVENTS);
  if (hub)         { where.push(hub.sql); params.push(...hub.params); }
  // rollups_daily.day is 'YYYY-MM-DD'; events.occurred_at is a full instant. A
  // bound is compared as a STRING, so '2026-05-03' >= '2026-05-03T00:00:00.000Z'
  // is FALSE — the shorter string sorts first — and the rollups branch silently
  // dropped the first day of every window the UI asked for. The Org page's
  // "Today" range sends exactly that, so in any timezone at or behind UTC it
  // showed empty tiles. Truncating the bound to a date makes the two branches
  // answer the same question, which BUG 61bdbd45 made newly load-bearing: the
  // same window now returns different days depending on whether ?types= is set.
  const bound = (v: string) => (timeCol === 'day' ? v.slice(0, 10) : v);
  if (f.from)      { where.push(`${timeCol} >= ?`); params.push(bound(f.from)); }
  if (f.to)        { where.push(`${timeCol} <= ?`); params.push(bound(f.to)); }
  return { where, params };
}

export function queriesRouter(ctx: HubServerContext): Router {
  const router = Router();

  // Authenticated and org-scoped, but every route here runs real SQL, so an
  // authenticated client in a loop is still a resource concern. Generous cap:
  // high enough that no legitimate dashboard hits it, low enough to bound abuse.
  // Keyed by the signed-in user, not the address: the hub is reached through
  // shared corporate egress, and an IP bucket would be an office-wide cap.
  router.use(rateLimit({ windowMs: 60 * 1000, max: 300, keyFn: sessionUserKey(ctx.config.sessionSecret), message: 'Too many requests, slow down.' }));
  const guard = requireSession(ctx.config.sessionSecret);

  router.get('/users', guard, asyncRoute(async (req: Request, res: Response) => {
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
  }));

  router.get('/timeline', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const limit = Math.min(Number.parseInt(singleValue(req, 'limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt(singleValue(req, 'offset') ?? '0', 10) || 0, 0);
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
  }));

  router.get('/metrics', guard, asyncRoute(async (req: Request, res: Response) => {
    await recomputeRollups(ctx.db);
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;

    // The rollups branch below cannot answer these. rollups_daily is keyed by
    // (org, person, day, hub) and carries counters — it has no `type`,
    // `remote_url` or `item_type` column at all, so any filter on those has to
    // be answered from the raw events. `types` was missing from this condition,
    // which is why ?types= never worked here (BUG 61bdbd45): the query reached
    // rollups_daily and failed on 'no such column: type'.
    if (f.projects || f.itemTypes || f.types) {
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
      // SUM + GROUP BY, not a bare SELECT: rollups_daily used to guarantee one
      // row per (org, person, day) through its PRIMARY KEY, and child_hub_id
      // joining that key removed the guarantee. On a parent hub the same person
      // and day now has a row per child hub plus the local one, so an
      // ungrouped select emitted duplicates — harmless to a consumer that only
      // totals them, wrong for anything keying by day. It also made the two
      // branches of this endpoint disagree: the events branch already groups.
      `SELECT user_key, day,
              SUM(events_count) AS events_count, SUM(items_closed) AS items_closed,
              SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
              SUM(validate_passes) AS validate_passes, SUM(validate_fails) AS validate_fails,
              SUM(prs_opened) AS prs_opened
       FROM rollups_daily WHERE ${where.join(' AND ')}
       GROUP BY user_key, day
       ORDER BY day ASC, user_key ASC`,
      params,
    );
    res.json({ bucket: 'day', series: rows.map(coerceMetricsRow) });
  }));

  router.get('/event-types', guard, asyncRoute(async (req: Request, res: Response) => {
    // Scoped by child hub but by nothing else: the chip list stays org-wide
    // across users/projects/time so a selection never removes its own chip.
    // The hub is different in kind — it partitions the data, it does not narrow
    // a view of it, and offering a type no selected hub ever reported is noise.
    const hub = childHubClause(readEventFilters(req).childHubs);
    const rows = await ctx.db.all<{ type: string }>(
      `SELECT DISTINCT type FROM events
       WHERE org_id = ?${hub.and}
       ORDER BY type ASC`,
      [req.session!.orgId, ...hub.params],
    );
    res.json({ types: rows.map(r => r.type) });
  }));

  router.get('/projects', guard, asyncRoute(async (req: Request, res: Response) => {
    // Same reasoning as /event-types: partitioned by hub, not narrowed by the
    // other filters. This also gives the repo list the provenance it lacked —
    // two hubs reporting unrelated repos no longer present one undifferentiated
    // list with no way to tell which group a repo came from.
    const hub = childHubClause(readEventFilters(req).childHubs);
    const rows = await ctx.db.all<{ remote_url: string }>(
      `SELECT DISTINCT remote_url FROM events
       WHERE org_id = ? AND remote_url IS NOT NULL AND remote_url != ''${hub.and}
       ORDER BY remote_url ASC`,
      [req.session!.orgId, ...hub.params],
    );
    res.json({ projects: rows.map(r => r.remote_url) });
  }));

  router.get('/item-types', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;

    const f = readEventFilters(req);

    // The list of all known item types stays org-wide so chips remain
    // selectable even when the current filter set produces zero hits — with the
    // child hub as the one exception, for the reason given on /event-types.
    const hub = childHubClause(f.childHubs);
    const allRows = await ctx.db.all<{ item_type: string }>(
      `SELECT DISTINCT item_type FROM events
       WHERE org_id = ? AND item_type IS NOT NULL AND item_type != ''${hub.and}
       ORDER BY item_type ASC`,
      [orgId, ...hub.params],
    );

    // Counts respect projects + event-type filters but ignore the itemTypes
    // filter — the UI uses these to show "what would I get if I selected
    // this chip", which is meaningless if we constrain by current selection.
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
  }));

  /**
   * Which hubs actually carry data in the current view — the options a child-hub
   * picker should offer.
   *
   * Deliberately NOT "every child hub ever enrolled": a hub enrolled last week
   * that has delivered nothing, or one whose events all fall outside the
   * selected window, is an option that returns an empty board when picked. The
   * every-hub list already exists for administration (/hub/admin/child-hubs);
   * this one answers a different question.
   *
   * Only the time window is applied. Not childHubId — a picker must not hide
   * the options next to the one selected — and not users/types/projects/
   * itemTypes either, for the same reason /event-types and /projects keep their
   * chip lists whole: narrowing to a local-only developer would empty this
   * picker and strand the reader on one hub with no control to leave it. The
   * hubs a caller has ALREADY selected are always offered, even with nothing in
   * the window, or narrowing the dates would strand them the same way.
   *
   * `childHubs[].events` are therefore counts for the window alone, unqualified
   * by any other filter the board is showing.
   *
   * `hasLocal` reports whether this hub has events of its own in the window, so
   * the picker can offer "This hub" without inventing a child_hubs row for the
   * parent. A standalone hub answers with an empty `childHubs`, and its UI can
   * drop the control entirely.
   */
  router.get('/child-hubs', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const f = readEventFilters(req);
    // Time window only. Not childHubId — a picker must not hide the options
    // next to the one selected — and not users/types/projects/itemTypes either,
    // for the same reason /event-types and /projects keep their chip lists
    // whole: narrowing to a local-only developer would empty this picker and
    // strand the reader on one hub with no visible control to leave it.
    const { where, params } = applyEventFilters(
      orgId,
      { users: null, types: null, projects: null, itemTypes: null, childHubs: null, from: f.from, to: f.to },
    );

    // One grouped pass over the window rather than a scan per question: the
    // local rows collapse to a single '' group that is split out below.
    const rows = await ctx.db.all<{ child_hub_id: string | null; events: number | string }>(
      `SELECT COALESCE(child_hub_id, '') AS child_hub_id, COUNT(*) AS events
       FROM events
       WHERE ${where.join(' AND ')}
       GROUP BY COALESCE(child_hub_id, '')`,
      params,
    );

    // Names come from child_hubs, but the events are the source of truth for
    // WHICH hubs to list: a detached hub's rows stay in the table and must keep
    // their label rather than turning into a bare UUID in the picker.
    //
    // The org filter here is defence in depth, not the tenant boundary — that
    // is the grouping above, which is org-scoped, so no foreign id can reach
    // this map in the first place. Deliberately unpinned by a test: nothing can
    // currently make it fail, and a test asserting otherwise would be theatre.
    const named = await ctx.db.all<{ id: string; name: string; detached_at: string | null }>(
      `SELECT id, name, detached_at FROM child_hubs WHERE org_id = ?`, [orgId],
    );
    const byId = new Map(named.map(n => [n.id, n]));

    let localEvents = 0;
    const childHubs: Array<{ id: string; name: string; detached: boolean; events: number }> = [];
    for (const r of rows) {
      const id = r.child_hub_id ?? '';
      if (id === '') { localEvents += Number(r.events); continue; }
      childHubs.push({
        id,
        name: byId.get(id)?.name ?? id,
        detached: byId.get(id)?.detached_at != null,
        events: Number(r.events),
      });
    }
    // Whatever the window says, the selection stays selectable.
    const present = new Set(childHubs.map(c => c.id));
    for (const id of selectedHubIds(f.childHubs)) {
      if (present.has(id) || !byId.has(id)) continue;
      childHubs.push({ id, name: byId.get(id)!.name, detached: byId.get(id)!.detached_at != null, events: 0 });
    }
    childHubs.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ childHubs, hasLocal: localEvents > 0 });
  }));

  router.get('/histogram', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const bucket = singleValue(req, 'bucket') ?? 'day';
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
  }));

  // PR Overview: total PRs per developer per size (XS–XL, derived from leaf
  // items), per period, total + daily, with a model breakdown/filter. pr.updated
  // re-sizes the same PR (counted once, at its latest sizing, attributed to the
  // opener).
  router.get('/prs/overview', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const f = readEventFilters(req);
    // Multi-select: a CSV of models, same parseList semantics as users/projects.
    // A single-value ?model=x link keeps working (one-element list).
    const models = parseList(req, 'model');
    // PR-number search (?pr=57 | #57 | a pasted PR URL). When it parses it
    // supersedes the date window, the model filter and the developer filter —
    // see PrWindow.prNumber. The projects filter is NOT superseded and needs no
    // special handling here: it stays inside `f` and keeps being pushed into SQL
    // as remote_url IN (...), which is what stops #57 matching every repo.
    // Passed through uncast: a repeated ?pr= arrives as an array and the parser
    // handles that shape rather than throwing.
    const prNumber = parsePrNumberFilter(req.query.pr);
    // Admin alias -> canonical. Resolved inside the aggregator for the rows, and
    // the filter values go through the same mapping so a saved link to
    // `?model=qwen38-27b` still finds the group now filed under `qwen3.8:27b`.
    const modelMapping = await loadModelMappings(ctx.db, orgId);
    // Provider + license class come from the admin-editable model_meta table
    // (seeded on first read). Keyed on the CANONICAL name, because that is what
    // byModel groups under after alias resolution — keying on the raw reported id
    // would leave every aliased model unclassified.
    const modelMetaRows = await loadModelMeta(ctx.db, orgId);

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
    //
    // A PR search lifts the upper bound too (`to: null` below). The bound exists
    // to keep "latest sizing wins" honest inside the requested window; for a
    // search the window is irrelevant, and honouring it would drop the re-size
    // events that happen to fall after `to` and report a stale size for the very
    // PR the user asked about.
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
                json_extract(payload, '$.payload.harness') AS harness,
                remote_url, child_hub_id
         FROM events WHERE ${where.join(' AND ')}
         ORDER BY occurred_at ASC`,
        base.params,
      );
    };

    // Provider/license metadata is resolved from the RAW reported ids, not from
    // the aggregated byModel list: the aggregator applies alias resolution and
    // needs the metadata at that moment. resolveModelMeta matches on a
    // normalised prefix, so an admin row for "qwen3.8-27b" still resolves a PR
    // reported as "qwen38-27b" or "@cf/zai-org/glm-5.2".
    const currentRows = await fetchRows(prNumber != null ? null : f.to);
    const rawModels = [...new Set(currentRows.map(r => r.model).filter((m): m is string => typeof m === 'string' && m.length > 0))];
    const modelMeta = resolveModelMetaAll(rawModels, modelMetaRows);

    const result = aggregatePrOverview(currentRows, {
      // In search mode the window, model and developer predicates are dropped at
      // the source, so the aggregator's own override is not the only thing
      // keeping them out — a caller reading this route sees the intent too.
      ...(prNumber != null
        ? { prNumber }
        : { from: f.from, to: f.to, models, developers: f.users }),
      modelMapping,
      // Keyed by the canonical name, for callers that filter that way, AND by
      // the raw reported id, which is what the aggregator needs to attach
      // metadata to an alias-resolved group. Passing only one of the two is how
      // a mapped model lost its provider in production.
      modelMeta: resolveModelMetaAll(
        [...new Set(rawModels.map(m => resolveModelId(m, modelMapping) ?? m))], modelMetaRows,
      ),
      modelMetaRaw: modelMeta,
    });

    // What period these numbers relate to. Normally the requested window. Under
    // a PR search it is the span of the matched PRs' OPEN times — and
    // deliberately nothing more. It is NOT a window to render a time axis from:
    // the search ignores ranges, a re-size can sit months outside this span, and
    // with no project selected the span crosses unrelated repos. A consumer that
    // lays out days should use `byDay`, which lists exactly the days that carry
    // data. Null when the search matched nothing — there is no period to claim.
    let period = { from: f.from, to: f.to };
    if (prNumber != null) {
      let first: string | null = null;
      let last: string | null = null;
      for (const p of result.prs) {
        if (first === null || p.openedAt < first) first = p.openedAt;
        if (last === null || p.openedAt > last) last = p.openedAt;
      }
      period = { from: first, to: last };
    }

    // Previous equal-length window for deltas — only when a lower bound is set.
    // The previous window's upper bound is EXCLUSIVE of `from` so a PR opened
    // exactly at `from` is counted in the current window only, never both.
    // A PR search skips it: the search ignores the window, so a "previous
    // period" comparison would be a number from a query nobody asked for.
    let previous: { prs: number; sizePoints: number } | null = null;
    if (f.from && prNumber == null) {
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

    res.json({ period, ...result, previous });
  }));

  // A malformed query parameter is the caller's mistake: a 400 that names it,
  // not the 500 an array reaching `.slice` or a SQL bind used to produce.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof BadQuery) { res.status(400).json({ error: err.message }); return; }
    next(err);
  });

  return router;
}
