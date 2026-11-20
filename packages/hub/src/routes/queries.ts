import { Router, Request, Response, NextFunction } from 'express';
import { HubServerContext } from '../server.js';
import { requireSession } from '../auth/session.js';
import { recomputeRollups } from '../rollup.js';
import { aggregateHistogramRows } from '../queries/histogram-aggregate.js';
import { isKnownTimeZone, rebucketToZone, subHourShift, zoneOffsetMin } from '../queries/histogram-zone.js';
import { coerceMetricsRow, coerceMetricsTotals } from '../queries/metrics-coerce.js';
import { aggregatePrOverview, clampTzOffsetMin, dayKeyer, parsePrNumberFilter, PrEventRow } from '../queries/pr-overview-aggregate.js';
import { sanitizeRemoteUrl } from './events.js';
import { rateLimit, sessionUserKey } from '../util/rateLimit.js';
import { loadModelMappings } from '../util/modelMapping.js';
import { loadModelMeta, resolveModelMetaAll } from '../util/modelMeta.js';
import { resolveModelId } from '../util/modelMapping.js';
import { childHubPredicate, childHubClause, selectedHubIds, HUB_COL_EVENTS, HUB_COL_ROLLUPS } from '../queries/childHub.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { prLinkFor, prUrlFor } from '../util/remoteUrl.js';
import { userKeyFor } from '../util/userKey.js';
import { loadAliasMap, resolveAliasKey } from '../util/userKeyAlias.js';
import { UsageGroup, tokenWeight, installationLabel, chunks, zeroTotals, addTotals, modelsOf, summaryFromModels, CardLedger } from '../util/usageGroup.js';
import { canonicalOccurredAt } from '../util/occurredAt.js';

/**
 * A query parameter that is not the shape the route reads. Express parses
 * `?from=a&from=b` into an array and `?from[a]=b` into an object, so a value
 * cast to string is a claim, not a check (CodeQL #107). Answered with a 400 by
 * the router's error handler below.
 */
class BadQuery extends Error {}

/** `?tzOffsetMin=` — the viewer's minutes EAST of UTC, clamped to a real
 *  zone; missing or unparseable means UTC. */
function readTzOffsetMin(req: Request): number {
  const raw = singleValue(req, 'tzOffsetMin');
  return clampTzOffsetMin(raw == null ? NaN : Number.parseInt(raw, 10));
}

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

/** At most this many closes are read per request; the reply says when it hit it. */
const USAGE_CARDS_LIMIT = 5000;
/** At most this many step events are summed per overview; the reply says when it hit it. */
const USAGE_OVERVIEW_LIMIT = 50000;
/** A project's usage on no card for one local day, the installation's running total (GH-394). */
const NO_CARD_EVENT = 'usage.no-card';
/** The By PR table's page size, unless the request asks for another, and the most it may ask for (GH-396). */
const USAGE_PRS_PAGE_SIZE = 25;
const USAGE_PRS_MAX_PAGE_SIZE = 100;
/** The By PR table's sort keys: one per column, plus the opening date it is listed by. */
const USAGE_PR_SORTS = ['opened', 'pr', 'card', 'createdBy', 'tokens', 'input', 'cacheRead', 'cacheWrite', 'output', 'cost'] as const;
type UsagePrSort = typeof USAGE_PR_SORTS[number];

/**
 * user_key -> display name for an org, as GET /v1/people/names serves it: keyed
 * exactly as ingest keys events (email, or a namespaced OS user, then aliases),
 * the most recently seen installation's name winning, then a federation
 * child's recorded names; a hidden person is never named.
 */
async function peopleNames(db: HubServerContext['db'], orgId: string): Promise<Record<string, string>> {
  const rows = await db.all<{ id: string; os_user: string | null; git_name: string | null; git_email: string | null }>(
    `SELECT id, os_user, git_name, git_email FROM installations
     WHERE org_id = ? AND git_name IS NOT NULL
     ORDER BY last_seen DESC`,
    [orgId],
  );
  const aliases = await loadAliasMap(db, orgId);
  const hidden = new Set((await db.all<{ user_key: string }>(
    'SELECT user_key FROM hidden_users WHERE org_id = ?', [orgId],
  )).map(h => h.user_key));
  const names: Record<string, string> = {};
  for (const row of rows) {
    const name = row.git_name?.trim();
    if (!name) continue;
    const key = resolveAliasKey(
      userKeyFor({ osUser: row.os_user ?? '', gitName: name, gitEmail: row.git_email }, row.id),
      aliases,
    );
    if (hidden.has(key) || key in names) continue;
    names[key] = name;
  }
  // A federation parent has no installation for a child hub's people; their
  // names are recorded at delivery (child_people, keep-policy rows only).
  // This hub's own installations win.
  const children = await db.all<{ user_key: string; git_name: string }>(
    'SELECT user_key, git_name FROM child_people WHERE org_id = ? ORDER BY last_seen DESC',
    [orgId],
  );
  for (const row of children) {
    const key = resolveAliasKey(row.user_key, aliases);
    if (hidden.has(key) || key in names) continue;
    names[key] = row.git_name;
  }
  return names;
}

function readEventFilters(req: Request): EventFilters {
  return {
    users: parseList(req, 'users'),
    types: parseList(req, 'types'),
    projects: parseList(req, 'projects'),
    itemTypes: parseList(req, 'itemTypes'),
    childHubs: parseList(req, 'childHubId'),
    from: timeBound(singleValue(req, 'from')),
    to: timeBound(singleValue(req, 'to')),
  };
}

/**
 * A window bound in the form events.occurred_at is stored in (GH-391), so
 * SQLite's text comparison and Postgres' instant comparison agree: '10:00:00Z'
 * would otherwise sort after the stored '10:00:00.000Z' on SQLite alone. One
 * that does not parse is passed on as sent, as before.
 */
function timeBound(v: string | null): string | null {
  return v == null ? v : canonicalOccurredAt(v) ?? v;
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

/** The item an event closed, or NULL: an item.closed, or the board's move to
 *  DONE. Counted DISTINCT, so an item closed twice counts once. */
const CLOSED_ITEM = `CASE
          WHEN type = 'item.closed' THEN item_id
          WHEN type = 'step.transitioned'
               AND json_extract(payload, '$.payload.toStatus') = 'DONE' THEN item_id
        END`;

/** A transition the server could judge: a step.transitioned whose payload
 *  carries the flow revision stamped at move time. Unstamped/legacy events are
 *  excluded from BOTH sides of the score, so they cannot drag adherence down. */
const JUDGED_TRANSITION = `type = 'step.transitioned'
               AND json_extract(payload, '$.payload.flowRevision') IS NOT NULL`;

/** …and compliant: the payload's verdict is true. SQLite reads a JSON boolean
 *  back as 1/0 while Postgres' jsonb_extract_path_text yields 'true'/'false',
 *  so LOWER(...) IN ('true','1') is the one spelling both agree on. The
 *  flowRevision guard is repeated so compliant can never exceed judged. */
const COMPLIANT_TRANSITION = `${JUDGED_TRANSITION}
               AND LOWER(json_extract(payload, '$.payload.compliant')) IN ('true','1')`;

/** A window's adherence score, or null when nothing was judged — never 0 for missing data. */
function adherenceOf(row: Record<string, unknown> | undefined) {
  const judged = Number(row?.judged ?? 0) || 0;
  const compliant = Number(row?.compliant ?? 0) || 0;
  return { judged, compliant, score: judged ? compliant / judged : null };
}

/** Shape a day-bucketed judged/compliant series into the response body. */
function adherencePayload(rows: Record<string, unknown>[]) {
  let judged = 0;
  let compliant = 0;
  const series = rows.map(r => {
    // Postgres returns bigint SUM as a string; Number() bridges both backends.
    const j = Number(r.judged ?? 0) || 0;
    const c = Number(r.compliant ?? 0) || 0;
    judged += j;
    compliant += c;
    return { day: String(r.day), judged: j, compliant: c, score: j ? c / j : null };
  });
  return { judged, compliant, score: judged ? compliant / judged : null, series };
}

export function queriesRouter(ctx: HubServerContext): Router {
  const router = Router();

  // Authenticated and org-scoped, but every route here runs real SQL, so an
  // authenticated client in a loop is still a resource concern. Generous cap:
  // high enough that no legitimate dashboard hits it, low enough to bound abuse.
  // Keyed by the signed-in user, not the address: the hub is reached through
  // shared corporate egress, and an IP bucket would be an office-wide cap.
  router.use(rateLimit({ windowMs: 60 * 1000, max: 300, keyFn: sessionUserKey(ctx.config.sessionSecret, ctx.db), message: 'Too many requests, slow down.' }));
  const guard = requireSession(ctx.config.sessionSecret, ctx.db);

  router.get('/users', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;
    const { where, params } = applyEventFilters(orgId, { ...f, users: null });
    const rows = await ctx.db.all<{ user_key: string; last_seen: unknown; events_count: number | string }>(
      `SELECT user_key,
              MAX(occurred_at) AS last_seen,
              COUNT(*) AS events_count
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY user_key
       ORDER BY last_seen DESC`,
      params,
    );

    // What each listed person got done, from the same events under every
    // filter EXCEPT event type: the list follows the type filter, but a person
    // listed for item.closed still shows their checks and PRs. Live events,
    // not rollups, so the row agrees with itself. "Closed" is defined exactly
    // as /metrics defines it.
    const done = applyEventFilters(orgId, { ...f, users: null, types: null });
    // The type IN (...) changes no count (every CASE ignores other types) but
    // lets the planner use the type index instead of reading every event in
    // the window. No SQL comments inside the query: they break on Postgres.
    const totals = await ctx.db.all<Record<string, unknown>>(
      `SELECT user_key,
              COUNT(DISTINCT ${CLOSED_ITEM}) AS items_closed,
              SUM(CASE WHEN type = 'validate.passed' THEN 1 ELSE 0 END) AS validate_passes,
              SUM(CASE WHEN type = 'validate.failed' THEN 1 ELSE 0 END) AS validate_fails,
              SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS prs_opened
       FROM events WHERE ${done.where.join(' AND ')}
         AND type IN ('item.closed', 'step.transitioned', 'validate.passed', 'validate.failed', 'pr.opened')
       GROUP BY user_key`,
      done.params,
    );
    // Per day in the viewer's zone when one is given (the histogram's rule:
    // hour groups in SQL, re-filed by the zone), else UTC days.
    const tzRaw = singleValue(req, 'tz');
    const timeZone = tzRaw && isKnownTimeZone(tzRaw) ? tzRaw : null;
    const atRaw = f.to ? Date.parse(f.to) : NaN;
    const shift = timeZone ? subHourShift(zoneOffsetMin(timeZone, Number.isNaN(atRaw) ? Date.now() : atRaw)) : 0;
    let daily: Array<{ user_key: string; day: string; n: number | string }>;
    if (timeZone) {
      // One row per (person, item, hour): a day is only known once the hour is
      // placed in the zone, and an item closed twice in that day (two hours, or
      // item.closed and the board's DONE either side of an hour) counts once.
      const hourly = await ctx.db.all<{ user_key: string; cid: string; hr: string }>(
        // Grouped over a derived table by name: positional GROUP BY trips pg-mem.
        `SELECT user_key, cid, hr FROM (
           SELECT user_key, ${CLOSED_ITEM} AS cid, strftime('%Y-%m-%dT%H:00', occurred_at${shift ? ', ?' : ''}) AS hr
           FROM events WHERE ${done.where.join(' AND ')}
             AND (type = 'item.closed' OR type = 'step.transitioned')
         ) closures
         WHERE cid IS NOT NULL
         GROUP BY user_key, cid, hr`,
        shift ? [`${shift} minutes`, ...done.params] : done.params,
      );
      // rebucketToZone keeps one row per (local day, type): with person and
      // item in the type slot, that is one row per distinct item per day.
      const userOf = new Map<string, string>();
      const placed = rebucketToZone(
        hourly.filter(h => h.cid != null).map(h => {
          const type = `${h.user_key}\u0000${h.cid}`;
          userOf.set(type, h.user_key);
          return { time: h.hr, type, n: 1 };
        }),
        timeZone, shift, 'day',
      );
      const perDay = new Map<string, { user_key: string; day: string; n: number }>();
      for (const r of placed) {
        const user = userOf.get(r.type)!;
        const k = `${user}\u0000${r.time}`;
        const cur = perDay.get(k) ?? { user_key: user, day: r.time, n: 0 };
        cur.n += 1;
        perDay.set(k, cur);
      }
      daily = [...perDay.values()];
    } else {
      daily = await ctx.db.all<{ user_key: string; day: string; n: number | string }>(
        `SELECT user_key, date(occurred_at) AS day, COUNT(DISTINCT ${CLOSED_ITEM}) AS n
         FROM events WHERE ${done.where.join(' AND ')}
           AND (type = 'item.closed' OR type = 'step.transitioned')
         GROUP BY user_key, day`,
        done.params,
      );
    }
    const num = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
    const byUser = new Map(totals.map(t => [String(t.user_key), t]));
    const closedDaily = new Map<string, Record<string, number>>();
    for (const d of daily) {
      const c = num(d.n);
      if (c === 0) continue;
      const m = closedDaily.get(d.user_key) ?? {};
      m[String(d.day).slice(0, 10)] = c;
      closedDaily.set(d.user_key, m);
    }

    res.json(rows.map(r => {
      const t = byUser.get(r.user_key);
      return {
        ...r,
        events_count: num(r.events_count),
        items_closed: num(t?.items_closed),
        validate_passes: num(t?.validate_passes),
        validate_fails: num(t?.validate_fails),
        prs_opened: num(t?.prs_opened),
        closed_daily: closedDaily.get(r.user_key) ?? {},
      };
    }));
  }));

  // The display name behind each user_key, so a dashboard can show "Carol Diaz"
  // rather than carol@acme.com. Keyed exactly as ingest keys events (email, or a
  // namespaced OS user, then aliases), so every key the other routes return can
  // be looked up. The most recently seen installation's name wins; a hidden
  // person is never named.
  router.get('/people/names', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json({ names: await peopleNames(ctx.db, req.session!.orgId) });
  }));

  router.get('/timeline', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = readEventFilters(req);
    const limit = Math.min(Number.parseInt(singleValue(req, 'limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt(singleValue(req, 'offset') ?? '0', 10) || 0, 0);
    // Keyset cursor "<occurred_at>|<event_id>": the next page starts strictly
    // after the last event shown, so events arriving in between cannot push a
    // shown one onto the next page, and ties on occurred_at cannot split
    // differently from one request to the next (event_id breaks them).
    const beforeRaw = singleValue(req, 'before');
    let before: { at: string; id: string } | null = null;
    if (beforeRaw != null) {
      const bar = beforeRaw.indexOf('|');
      const at = bar > 0 ? beforeRaw.slice(0, bar) : '';
      const id = bar > 0 ? beforeRaw.slice(bar + 1) : '';
      if (!at || !id || Number.isNaN(Date.parse(at.replace(' ', 'T')))) {
        throw new BadQuery("Query parameter 'before' must be '<occurred_at>|<event_id>'.");
      }
      before = { at, id };
    }
    const { where, params } = applyEventFilters(req.session!.orgId, f);
    // The leading `occurred_at <= ?` is redundant with the OR but gives the
    // planner a range to seek on idx_events_user_time instead of scanning
    // down from the newest row.
    const pageWhere = before ? [...where, 'occurred_at <= ?', '(occurred_at < ? OR (occurred_at = ? AND event_id < ?))'] : where;
    const pageParams = before ? [...params, before.at, before.at, before.at, before.id] : params;

    const rows = await ctx.db.all<any>(
      `SELECT event_id, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, item_title, external_id, user_key, reporting_version, payload
       FROM events WHERE ${pageWhere.join(' AND ')}
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ? OFFSET ?`,
      [...pageParams, limit, before ? 0 : offset],
    );

    // How many events match in all, so a page can say what it is a page of.
    // Only on the first page: a cursor page is a continuation and the client
    // keeps the first page's count. Served by idx_events_user_time for the one
    // caller (a person's page); an org-wide caller would scan more.
    let total: number | undefined;
    if (!before) {
      const countRow = await ctx.db.get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')}`,
        params,
      );
      // Postgres returns COUNT as a bigint string.
      total = Number(countRow?.n ?? 0);
    }
    const last = rows[rows.length - 1];
    const lastAt = last ? (last.occurred_at instanceof Date ? last.occurred_at.toISOString() : String(last.occurred_at)) : '';

    res.json({
      events: rows.map((r: any) => {
        const payload = JSON.parse(r.payload);
        const inner = payload?.payload ?? {};
        // A link for a PR event, by the drill-down's rule: github.com only,
        // never guessed for another host.
        const pr_url = r.type === 'pr.opened' || r.type === 'pr.updated'
          ? prUrlFor(r.remote_url, typeof inner.repo === 'string' ? inner.repo : null, inner.prNumber)
          : null;
        return { ...r, payload, pr_url };
      }),
      // offset is ignored under a cursor, so it is not echoed as if it applied.
      limit, offset: before ? 0 : offset, total,
      // Present while a full page came back: there may be more.
      nextBefore: rows.length === limit && last ? `${lastAt}|${last.event_id}` : undefined,
    });
  }));

  /**
   * GH-389: closed cards with their token usage, newest close first. Usage
   * reaches the hub only on workflow events - a card's whole usage rides its
   * item.closed (payload.usage) - so this reads those, the latest close per
   * card (a card reopened and closed again counts once, as it last closed).
   * A close from a version that sent no usage has usage null: unmeasured,
   * which is not zero. Same filters as the board's other reads, except types.
   */
  router.get('/usage/cards', guard, asyncRoute(async (req: Request, res: Response) => {
    const f = { ...readEventFilters(req), types: ['item.closed'] };
    const { where, params } = applyEventFilters(req.session!.orgId, f);
    const rows = await ctx.db.all<any>(
      `SELECT event_id, occurred_at, item_id, item_type, item_title, external_id, remote_url, user_key, payload
         FROM events WHERE ${where.join(' AND ')} AND item_id IS NOT NULL
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?`,
      [...params, USAGE_CARDS_LIMIT],
    );
    const seen = new Set<string>();
    const cards = [];
    for (const r of rows) {
      if (seen.has(r.item_id)) continue;
      seen.add(r.item_id);
      let usage: unknown = null;
      try { usage = JSON.parse(r.payload)?.payload?.usage ?? null; } catch { /* unreadable: unmeasured */ }
      cards.push({
        item_id: r.item_id,
        item_type: r.item_type ?? null,
        item_title: r.item_title ?? null,
        external_id: r.external_id ?? null,
        remote_url: r.remote_url ?? null,
        user_key: r.user_key ?? null,
        // Postgres returns a Date, SQLite the stored text: one shape out.
        closed_at: new Date(r.occurred_at).toISOString(),
        usage,
      });
    }
    res.json({ cards, truncated: rows.length === USAGE_CARDS_LIMIT });
  }));

  /**
   * GH-389 follow-up: the org's usage over the board filters, by installation,
   * by user and by harness/model. Usage by PR is GET /v1/usage/prs (GH-396).
   *
   * Usage reaches the hub on a card's step changes and its close, and counts
   * when it arrives. Each of those events carries the card's own usage to
   * date (usage.own; descendants excluded): the hub keeps a ledger per card
   * and credits each event with what its snapshot has beyond what the card
   * already recorded (CardLedger). A turn ingested late is in the next
   * snapshot; none is counted twice, whatever the order of a step and its
   * close or a reopen. Steps from versions before the snapshot are deltas;
   * their closes carry the subtree total, which is never summed. A card's
   * current step is not on the hub until it moves. A step with no usage is
   * unmeasured, not zero. ?types= is ignored.
   *
   * GH-394: usage on no card (`noCard`) arrives as each installation's running
   * total per project and local day; it is in `total`, never in the card
   * breakdowns, and an item-type filter leaves it out.
   */
  router.get('/usage/overview', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const base = readEventFilters(req);
    const parse = (raw: string): any => { try { return JSON.parse(raw); } catch { return null; } };
    const timeOf = (v: unknown) => new Date(v as any).getTime();
    const iso = (v: unknown) => new Date(v as any).toISOString();
    // Ingest has stored any string as a timestamp: a row that does not parse is
    // skipped and counted, never a failed request.
    const validTime = (v: unknown) => Number.isFinite(timeOf(v));
    // One count per event, however many of the reads below meet it.
    const malformed = new Set<string>();
    const usable = (r: { event_id: unknown; occurred_at: unknown }) => {
      if (validTime(r.occurred_at)) return true;
      malformed.add(String(r.event_id));
      return false;
    };
    const USAGE_TYPES = ['step.transitioned', 'item.closed'];

    const all = new UsageGroup();
    const byInstallation = new Map<string, UsageGroup>();
    const byUser = new Map<string, UsageGroup>();
    // The timeline: each credit on the viewer's day (an IANA zone, else an offset, else UTC).
    const dayOf = dayKeyer(singleValue(req, 'tz'), readTzOffsetMin(req));
    const byDay = new Map<string, UsageGroup>();
    const credit = (r: { installation_id: unknown; user_key: unknown; item_id: string | null; occurred_at: unknown }, usage: unknown) => {
      all.add(r.item_id, usage);
      const day = dayOf(iso(r.occurred_at));
      if (!byDay.has(day)) byDay.set(day, new UsageGroup());
      byDay.get(day)!.add(r.item_id, usage);
      const inst = String(r.installation_id);
      if (!byInstallation.has(inst)) byInstallation.set(inst, new UsageGroup());
      byInstallation.get(inst)!.add(r.item_id, usage);
      const user = String(r.user_key);
      if (!byUser.has(user)) byUser.set(user, new UsageGroup());
      byUser.get(user)!.add(r.item_id, usage);
    };

    // 1. The usage events in the window.
    const winF = applyEventFilters(orgId, { ...base, types: USAGE_TYPES });
    const winRows = await ctx.db.all<any>(
      `SELECT event_id, type, installation_id, user_key, item_id, occurred_at, payload
         FROM events WHERE ${winF.where.join(' AND ')}
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?`,
      [...winF.params, USAGE_OVERVIEW_LIMIT + 1],
    );
    let truncated = winRows.length > USAGE_OVERVIEW_LIMIT;
    const inWindow = new Map<string, any>();
    let measured = 0;
    let unmeasured = 0;
    let incomplete = 0;
    for (const r of winRows.slice(0, USAGE_OVERVIEW_LIMIT)) {
      if (!usable(r)) continue;
      const usage = parse(r.payload)?.payload?.usage;
      if (r.type === 'step.transitioned') {
        if (!usage || typeof usage !== 'object') { unmeasured++; continue; }
        measured++;
        if (usage.complete === false) incomplete++;
      }
      if (!usage || typeof usage !== 'object') continue;
      // No card to keep a ledger for: a delta is all the hub can credit.
      if (!r.item_id) { if (r.type === 'step.transitioned') credit(r, summaryFromModels(modelsOf(usage))); continue; }
      inWindow.set(String(r.event_id), r);
    }

    // 2. Each card's ledger over its whole history, crediting only the events
    //    in the window. The whole history, past the window's end too: an event
    //    emitted after the window can precede one inside it in read order
    //    (own.asOf), and disjoint windows must add up to the whole.
    const cardIds = [...new Set([...inWindow.values()].map(r => r.item_id as string))];
    const history: any[] = [];
    for (const ids of chunks(cardIds)) {
      history.push(...await ctx.db.all<any>(
        `SELECT event_id, type, item_id, occurred_at, payload FROM events
          WHERE org_id = ? AND type IN ('step.transitioned', 'item.closed') AND item_id IN (${ids.map(() => '?').join(',')})`,
        [orgId, ...ids],
      ));
    }
    const rank = (t: string) => (t === 'item.closed' ? 1 : 0);
    for (let i = history.length - 1; i >= 0; i--) if (!usable(history[i])) history.splice(i, 1);
    // A snapshot's place is when it was READ (own.asOf): a move reads its card
    // only after the previous move saved, so read order is the card's order,
    // while emission order is not (a slow route can emit an older snapshot
    // late). Older versions sent no asOf; their emission time stands in.
    for (const h of history) {
      h.usage = parse(h.payload)?.payload?.usage;
      const asOf = timeOf(h.usage?.own?.asOf);
      h.order = Number.isFinite(asOf) ? asOf : timeOf(h.occurred_at);
    }
    history.sort((x, y) => String(x.item_id).localeCompare(String(y.item_id))
      || x.order - y.order
      || rank(x.type) - rank(y.type)
      || String(x.event_id).localeCompare(String(y.event_id)));
    const ledgers = new Map<string, CardLedger>();
    const recovered = zeroTotals();
    for (const h of history) {
      const usage = h.usage;
      if (!usage || typeof usage !== 'object') continue;
      let ledger = ledgers.get(h.item_id);
      if (!ledger) { ledger = new CardLedger(); ledgers.set(h.item_id, ledger); }
      let credited;
      if (usage.own) credited = ledger.addSnapshot(modelsOf(usage.own));
      else if (h.type === 'step.transitioned') credited = ledger.addDelta(modelsOf(usage));
      else continue; // an older close: its total is the subtree's
      const row = inWindow.get(String(h.event_id));
      if (!row || credited.length === 0) continue;
      const sum = summaryFromModels(credited);
      if (h.type === 'item.closed') addTotals(recovered, sum.total);
      credit(row, sum);
    }

    // 3. Usage on no card (GH-394): each installation's running total per
    //    project and local day. Every send is stored; the latest (payload.asOf)
    //    stands for the key, so a resend replaces and never adds. It is credited
    //    to the window holding that latest send, read across the whole time
    //    span its key can occupy, so disjoint windows add up to the whole. It
    //    has no card, so an item-type filter leaves it out and it is no PR's.
    const noCardAll = new UsageGroup();
    const noCardByDay = new Map<string, UsageGroup>();
    const noCardByInstallation = new Map<string, UsageGroup>();
    const noCardByUser = new Map<string, UsageGroup>();
    if (!base.itemTypes) {
      const ncF = applyEventFilters(orgId, { ...base, types: [NO_CARD_EVENT] });
      const ncRows = await ctx.db.all<any>(
        `SELECT event_id, installation_id, project_id, occurred_at FROM events WHERE ${ncF.where.join(' AND ')}
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT ?`,
        [...ncF.params, USAGE_OVERVIEW_LIMIT + 1],
      );
      if (ncRows.length > USAGE_OVERVIEW_LIMIT) truncated = true;
      const picked = new Set<string>();
      let earliest = Infinity;
      let latest = -Infinity;
      for (const r of ncRows.slice(0, USAGE_OVERVIEW_LIMIT)) {
        if (!usable(r)) continue;
        picked.add(String(r.event_id));
        earliest = Math.min(earliest, timeOf(r.occurred_at));
        latest = Math.max(latest, timeOf(r.occurred_at));
      }
      // Each picked installation's own picked projects (null: a send with no project).
      const pairs = new Map<string, Set<string | null>>();
      for (const r of ncRows) {
        if (!picked.has(String(r.event_id))) continue;
        const inst = String(r.installation_id);
        if (!pairs.has(inst)) pairs.set(inst, new Set());
        pairs.get(inst)!.add(r.project_id == null ? null : String(r.project_id));
      }
      // A key's sends all fall in its local day: within two days of any one of them.
      const span = 2 * 24 * 60 * 60 * 1000;
      const versions: any[] = [];
      for (const [inst, projectSet] of pairs) {
        const projects = [...projectSet].filter((p): p is string => p !== null);
        const projectChunks: Array<string[] | null> = [...chunks(projects), ...(projectSet.has(null) ? [null] : [])];
        for (const pids of projectChunks) {
          versions.push(...await ctx.db.all<any>(
            `SELECT event_id, installation_id, user_key, project_id, occurred_at, payload FROM events
              WHERE org_id = ? AND type = ? AND installation_id = ?
                AND ${pids ? `project_id IN (${pids.map(() => '?').join(',')})` : 'project_id IS NULL'}
                AND occurred_at >= ? AND occurred_at <= ?`,
            [orgId, NO_CARD_EVENT, inst, ...(pids ?? []), iso(earliest - span), iso(latest + span)],
          ));
        }
      }
      const newest = new Map<string, { row: any; order: number; usage: any }>();
      for (const v of versions) {
        if (!usable(v)) continue;
        const p = parse(v.payload)?.payload;
        const day = typeof p?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.day) ? p.day : null;
        if (!day || !p.usage || typeof p.usage !== 'object') {
          if (picked.has(String(v.event_id))) malformed.add(String(v.event_id));
          continue;
        }
        const asOf = timeOf(p.asOf);
        const order = Number.isFinite(asOf) ? asOf : timeOf(v.occurred_at);
        const key = `${v.installation_id}\u0000${v.project_id ?? ''}\u0000${day}`;
        const prev = newest.get(key);
        if (prev && (prev.order > order || (prev.order === order && String(prev.row.event_id) > String(v.event_id)))) continue;
        newest.set(key, { row: v, order, usage: p.usage });
      }
      const group = (m: Map<string, UsageGroup>, k: string) => {
        if (!m.has(k)) m.set(k, new UsageGroup());
        return m.get(k)!;
      };
      for (const { row, usage } of newest.values()) {
        if (!picked.has(String(row.event_id))) continue;
        const sum = summaryFromModels(modelsOf(usage));
        noCardAll.add(null, sum);
        group(noCardByDay, dayOf(iso(row.occurred_at))).add(null, sum);
        group(noCardByInstallation, String(row.installation_id)).add(null, sum);
        group(noCardByUser, String(row.user_key)).add(null, sum);
      }
    }

    const instIds = [...new Set([...byInstallation.keys(), ...noCardByInstallation.keys()])];
    const identities = new Map<string, any>();
    for (const ids of chunks(instIds)) {
      const found = await ctx.db.all<any>(
        `SELECT id, git_name, git_email, os_user FROM installations WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        [orgId, ...ids],
      );
      for (const f of found) identities.set(f.id, f);
    }
    const ordered = (m: Map<string, UsageGroup>, key: string, extra: (id: string) => Record<string, unknown> = () => ({})) =>
      [...m.entries()]
        .sort(([a, ga], [b, gb]) => tokenWeight(gb.total) - tokenWeight(ga.total) || a.localeCompare(b))
        .map(([id, g]) => ({ [key]: id, ...extra(id), cards: g.cards, total: g.total, byModel: g.byModel() }));

    const total = zeroTotals();
    addTotals(total, all.total);
    addTotals(total, noCardAll.total);
    const noCardRows = (m: Map<string, UsageGroup>, key: string, extra: (id: string) => Record<string, unknown> = () => ({})) =>
      ordered(m, key, extra).map(({ cards: _cards, ...row }) => row);
    res.json({
      // Cards and usage on no card; every breakdown below is the cards' only, and noCard has its own.
      total,
      cards: all.cards,
      steps: measured,
      unmeasuredSteps: unmeasured,
      incompleteSteps: incomplete,
      recoveredAtClose: recovered,
      byInstallation: ordered(byInstallation, 'installation_id', id => ({ label: installationLabel(identities.get(id)) })),
      byUser: ordered(byUser, 'user_key'),
      byModel: all.byModel(),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([day, g]) => ({ day, cards: g.cards, total: g.total, byModel: g.byModel() })),
      noCard: {
        total: noCardAll.total,
        byModel: noCardAll.byModel(),
        byInstallation: noCardRows(noCardByInstallation, 'installation_id', id => ({ label: installationLabel(identities.get(id)) })),
        byUser: noCardRows(noCardByUser, 'user_key'),
        byDay: [...noCardByDay.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([day, g]) => ({ day, total: g.total, byModel: g.byModel() })),
      },
      truncated,
      malformedEvents: malformed.size,
    });
  }));

  /**
   * GH-396: usage by PR, one page at a time. The board filters pick the PRs:
   * one registered or updated in the window, by the people chosen. Each PR's
   * anchor card, opening date, opener (created_by) and link come from its
   * whole history, so a filter cannot resurrect an old anchor; its usage is
   * the anchor's latest close (card + subtree), null while that card is open
   * or after a step left the closed status.
   *
   * The table's own filters (`repos`, `q`: a PR number or part of the card
   * title, `status`: closed | open), its sort (`sort`, `dir`) and its paging
   * (`page`, `pageSize`) run here, so a response is one page and `total`.
   * Cost sorts by what the usage stored: reported (costUsd) plus the estimate
   * priced when the turns were recorded (estimatedCostUsd, GH-397). Turns with
   * neither (`unpricedTurns`: recorded before turns were priced, or of a model
   * the price table did not list) add nothing to it; the page prices them at
   * today's prices where it can. `costWithoutEstimate` counts the PRs with any
   * such turns under a cost sort (null under any other).
   * A PR not closed yet sorts last on a usage column, either way. Closes are
   * read for the page's PRs only, unless a status filter or a usage sort needs
   * them all; `malformedEvents` counts what this request read.
   */
  router.get('/usage/prs', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const base = readEventFilters(req);
    const repoFilter = parseList(req, 'repos');
    const text = (singleValue(req, 'q') ?? '').trim();
    const status = singleValue(req, 'status');
    if (status !== null && status !== 'closed' && status !== 'open') throw new BadQuery("Query parameter 'status' must be 'closed' or 'open'.");
    const sortRaw = singleValue(req, 'sort') ?? 'opened';
    if (!(USAGE_PR_SORTS as readonly string[]).includes(sortRaw)) throw new BadQuery(`Query parameter 'sort' must be one of ${USAGE_PR_SORTS.join(', ')}.`);
    const sort = sortRaw as UsagePrSort;
    const dirRaw = singleValue(req, 'dir');
    if (dirRaw !== null && dirRaw !== 'asc' && dirRaw !== 'desc') throw new BadQuery("Query parameter 'dir' must be 'asc' or 'desc'.");
    const dir = dirRaw ?? (sort === 'opened' ? 'desc' : 'asc');
    const positive = (name: string): number | null => {
      const raw = singleValue(req, name);
      if (raw === null) return null;
      if (!/^[1-9]\d{0,8}$/.test(raw)) throw new BadQuery(`Query parameter '${name}' must be a whole number from 1.`);
      return Number(raw);
    };
    const pageSize = Math.min(positive('pageSize') ?? USAGE_PRS_PAGE_SIZE, USAGE_PRS_MAX_PAGE_SIZE);
    const askedPage = positive('page') ?? 1;

    const parse = (raw: string): any => { try { return JSON.parse(raw); } catch { return null; } };
    const timeOf = (v: unknown) => new Date(v as any).getTime();
    const malformed = new Set<string>();
    const usable = (r: { event_id: unknown; occurred_at: unknown }) => {
      if (Number.isFinite(timeOf(r.occurred_at))) return true;
      malformed.add(String(r.event_id));
      return false;
    };
    const prKey = (p: any): string | null => {
      const repo = typeof p?.repo === 'string' ? p.repo : null;
      const num = Number(p?.prNumber);
      return repo && Number.isInteger(num) ? `${repo.toLowerCase()}#${num}` : null;
    };

    const prsF = applyEventFilters(orgId, { ...base, types: ['pr.opened', 'pr.updated'] });
    const picked = new Set<string>();
    for (const r of await ctx.db.all<any>(
      `SELECT payload FROM events WHERE ${prsF.where.join(' AND ')} AND item_id IS NOT NULL`, prsF.params,
    )) {
      const k = prKey(parse(r.payload)?.payload);
      if (k) picked.add(k);
    }
    type Pr = {
      repo: string; pr_number: number; item_id: string; item_type: string | null; item_title: string | null;
      opened_at: string; closed_at: string | null; created_by: string | null; url: string | null; usage: any;
    };
    const prs = new Map<string, Pr>();
    const openedBy = new Map<string, string>();
    if (picked.size > 0) {
      // A PR is known by its repo and number, not by the remote of the card it
      // was registered from (a fork and its upstream name one PR), so its
      // history is read across the org's PR events - a handful per PR.
      const prHistory = (await ctx.db.all<any>(
        `SELECT event_id, type, occurred_at, item_id, item_type, item_title, user_key, remote_url, payload FROM events
          WHERE org_id = ? AND type IN ('pr.opened', 'pr.updated') AND item_id IS NOT NULL`,
        [orgId],
      )).filter(usable);
      prHistory.sort((x, y) => timeOf(x.occurred_at) - timeOf(y.occurred_at)
        || String(x.event_id).localeCompare(String(y.event_id)));
      for (const r of prHistory) {
        const p = parse(r.payload)?.payload;
        const k = prKey(p);
        if (!k || !picked.has(k)) continue;
        const prev = prs.get(k);
        // The opener: the first pr.opened, else (a PR only ever seen updated) the first event.
        const opensIt = !prev || (r.type === 'pr.opened' && openedBy.get(k) !== 'pr.opened');
        if (opensIt) openedBy.set(k, String(r.type));
        prs.set(k, {
          repo: p.repo, pr_number: Number(p.prNumber), item_id: r.item_id,
          item_type: r.item_type ?? prev?.item_type ?? null,
          item_title: r.item_title ?? prev?.item_title ?? null,
          opened_at: prev?.opened_at ?? new Date(r.occurred_at).toISOString(), closed_at: null,
          created_by: opensIt ? (r.user_key == null ? null : String(r.user_key)) : prev.created_by,
          url: prLinkFor(r.remote_url, p.repo, p.prNumber),
          usage: null,
        });
      }
    }

    const all = [...prs.values()];
    // The repository choices: every repo the board filters picked, before the table's own filters.
    const repoNames = new Map<string, string>();
    for (const p of all) if (!repoNames.has(p.repo.toLowerCase())) repoNames.set(p.repo.toLowerCase(), p.repo);

    // Each anchor's latest close (later event id at one instant), unless a
    // step moved the card after it: a reopened card's close no longer stands.
    const resolveUsage = async (list: Pr[]) => {
      const closes = new Map<string, { at: number; id: string; status: string; usage: unknown }>();
      const leftAt = new Map<string, Array<{ at: number; from: string | undefined }>>();
      for (const ids of chunks([...new Set(list.map(p => p.item_id))])) {
        const found = await ctx.db.all<any>(
          `SELECT item_id, type, occurred_at, event_id, payload FROM events
            WHERE org_id = ? AND type IN ('item.closed', 'step.transitioned') AND item_id IN (${ids.map(() => '?').join(',')})`,
          [orgId, ...ids],
        );
        for (const f of found) {
          if (!usable(f)) continue;
          const at = timeOf(f.occurred_at);
          const p = parse(f.payload)?.payload;
          if (f.type === 'step.transitioned') {
            if (!leftAt.has(f.item_id)) leftAt.set(f.item_id, []);
            leftAt.get(f.item_id)!.push({ at, from: p?.fromStatus });
            continue;
          }
          const prev = closes.get(f.item_id);
          if (prev && (prev.at > at || (prev.at === at && prev.id > String(f.event_id)))) continue;
          closes.set(f.item_id, { at, id: String(f.event_id), status: p?.toStatus ?? 'DONE', usage: p?.usage ?? null });
        }
      }
      for (const p of list) {
        const c = closes.get(p.item_id);
        // Reopened: a step left the closed status after the close. The closing
        // step itself (into that status) never counts, whatever its clock says.
        if (!c || (leftAt.get(p.item_id) ?? []).some(m => m.from === c.status && m.at >= c.at)) continue;
        p.closed_at = new Date(c.at).toISOString();
        p.usage = c.usage;
      }
    };

    // The filters that need no usage go first, so the closes are read for as few PRs as the answer needs.
    const wanted = repoFilter ? new Set(repoFilter.map(r => r.toLowerCase())) : null;
    const asNumber = /^#?\d+$/.test(text) ? Number(text.replace('#', '')) : null;
    const needle = text.toLowerCase();
    let rows = all.filter(p => {
      if (wanted && !wanted.has(p.repo.toLowerCase())) return false;
      if (!text) return true;
      if (asNumber !== null && p.pr_number === asNumber) return true;
      return (p.item_title ?? '').toLowerCase().includes(needle);
    });
    // A status filter or a usage column needs every remaining PR's close; otherwise only the page's.
    const usageFirst = status !== null || !['opened', 'pr', 'card', 'createdBy'].includes(sort);
    if (usageFirst) {
      await resolveUsage(rows);
      if (status) rows = rows.filter(p => (status === 'closed' ? !!p.closed_at : !p.closed_at));
    }

    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const totalOf = (p: Pr) => (p.usage && typeof p.usage === 'object' && p.usage.total && typeof p.usage.total === 'object' ? p.usage.total : null);
    const names = sort === 'createdBy' ? await peopleNames(ctx.db, orgId) : {};
    const raw = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const textCmp = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || raw(a, b);
    const byPr = (a: Pr, b: Pr) => textCmp(a.repo, b.repo) || a.pr_number - b.pr_number;
    /** The sorted column's value; null (no usage yet, no opener) sorts last either way. */
    const value = (p: Pr): string | number | null => {
      const t = totalOf(p);
      switch (sort) {
        case 'opened': case 'pr': return null;
        case 'card': return p.item_title ?? p.item_id;
        case 'createdBy': return p.created_by == null ? null : (Object.hasOwn(names, p.created_by) ? names[p.created_by] : p.created_by);
        case 'tokens': return t ? num(t.input) + num(t.cacheRead) + num(t.cacheWrite) + num(t.output) : null;
        case 'cost': return t ? num(t.costUsd) + num(t.estimatedCostUsd) : null;
        default: return t ? num(t[sort]) : null;
      }
    };
    const sign = dir === 'asc' ? 1 : -1;
    const compare = (a: { p: Pr; v: string | number | null }, b: { p: Pr; v: string | number | null }): number => {
      if (sort === 'opened') return raw(a.p.opened_at, b.p.opened_at) * sign;
      if (sort === 'pr') return byPr(a.p, b.p) * sign;
      if (a.v === null || b.v === null) return a.v === b.v ? 0 : a.v === null ? 1 : -1;
      return (typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : textCmp(String(a.v), String(b.v))) * sign;
    };
    const keyed = rows.map(p => ({ p, v: value(p) }));
    // One order on every page: ties go newest opened first, then repository and number.
    keyed.sort((a, b) => compare(a, b) || raw(b.p.opened_at, a.p.opened_at) || byPr(a.p, b.p));

    const repos = [...repoNames.values()].sort(textCmp);
    const total = keyed.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(askedPage, pages);
    const pageRows = keyed.slice((page - 1) * pageSize, page * pageSize).map(({ p }) => p);
    if (!usageFirst) await resolveUsage(pageRows);
    // Only a cost sort is affected, and only then is every row's usage read.
    const costWithoutEstimate = sort !== 'cost' ? null : rows.filter(p => num(totalOf(p)?.unpricedTurns) > 0).length;
    res.json({
      rows: pageRows,
      total, page, pageSize, sort, dir, repos, costWithoutEstimate,
      malformedEvents: malformed.size,
    });
  }));

  router.get('/metrics', guard, asyncRoute(async (req: Request, res: Response) => {
    await recomputeRollups(ctx.db);
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;

    // The period's totals, from the live events under the same rules as
    // /v1/users: the exact `from` (rollups cut it to its UTC day) and each
    // item closed once over the window (rollups count it once per day, so the
    // summed series counts an item closed on two days twice). The Org and
    // person tiles read these, so they agree with the rows beside them
    // (BUG 72c309df). The series stays for anything charting by day.
    const tf = applyEventFilters(orgId, f);
    const totals = coerceMetricsTotals(await ctx.db.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS events_count,
              COUNT(DISTINCT ${CLOSED_ITEM}) AS items_closed,
              SUM(CASE WHEN type = 'validate.passed' THEN 1 ELSE 0 END) AS validate_passes,
              SUM(CASE WHEN type = 'validate.failed' THEN 1 ELSE 0 END) AS validate_fails,
              SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS prs_opened
       FROM events WHERE ${tf.where.join(' AND ')}`,
      tf.params,
    ));

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
                COUNT(DISTINCT ${CLOSED_ITEM}) AS items_closed,
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
      res.json({ bucket: 'day', series: rows.map(coerceMetricsRow), totals });
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
    res.json({ bucket: 'day', series: rows.map(coerceMetricsRow), totals });
  }));

  // Org-level flow adherence: of the transitions the server could judge against
  // the flow revision in force, how many stayed within that revision. A rollback
  // between two steps of the same revision is COMPLIANT — there is no direction
  // term — so honest rollbacks are not penalised. Shares the filter set with
  // every other view here, which is what makes the hub's filters uniform.
  router.get('/adherence', guard, asyncRoute(async (req: Request, res: Response) => {
    await recomputeRollups(ctx.db);
    const f = readEventFilters(req);
    const orgId = req.session!.orgId;

    // rollups_daily has no type/remote_url/item_type column, so any filter on
    // those has to be answered from the raw events — the same rule /v1/metrics
    // documents (BUG 61bdbd45). Everything else reads the counters S2 added.
    if (f.projects || f.itemTypes || f.types) {
      const { where, params } = applyEventFilters(orgId, f);
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT date(occurred_at) AS day,
                SUM(CASE WHEN ${JUDGED_TRANSITION} THEN 1 ELSE 0 END) AS judged,
                SUM(CASE WHEN ${COMPLIANT_TRANSITION} THEN 1 ELSE 0 END) AS compliant
         FROM events WHERE ${where.join(' AND ')}
         GROUP BY day
         ORDER BY day ASC`,
        params,
      );
      res.json(adherencePayload(rows));
      return;
    }

    const { where, params } = applyEventFilters(orgId, f, 'day');
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT day,
              SUM(transitions_judged) AS judged,
              SUM(transitions_compliant) AS compliant
       FROM rollups_daily WHERE ${where.join(' AND ')}
       GROUP BY day
       ORDER BY day ASC`,
      params,
    );
    res.json(adherencePayload(rows));
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
    const tzShift = readTzOffsetMin(req);
    const f = readEventFilters(req);
    const { where, params } = applyEventFilters(orgId, f);

    // With a zone the hub knows, group by hour in SQL and re-file the hours by
    // the zone's own rules for each date (DST included); otherwise shift every
    // event by the one offset given, as before.
    const tzRaw = singleValue(req, 'tz');
    const timeZone = tzRaw && isKnownTimeZone(tzRaw) ? tzRaw : null;
    // A known zone sets its own alignment; the client's offset only matters
    // for a zone the hub cannot read. Read at the window's end (or now).
    const atRaw = f.to ? Date.parse(f.to) : NaN;
    const shift = timeZone
      ? subHourShift(zoneOffsetMin(timeZone, Number.isNaN(atRaw) ? Date.now() : atRaw))
      : tzShift;

    const fmt = bucket === 'day' && !timeZone ? '%Y-%m-%d' : '%Y-%m-%dT%H:00';
    const tzModifier = shift !== 0 ? `, ?` : '';
    const sqlParams: any[] = [];
    // No leading '+': SQLite and Postgres take '30 minutes' as positive, and
    // pg-mem (the parity tests' Postgres) cannot parse '+30 minutes'.
    if (shift !== 0) sqlParams.push(`${shift} minutes`);
    sqlParams.push(...params);
    const rows = await ctx.db.all<{ time: string; type: string; n: number | string }>(
      `SELECT strftime('${fmt}', occurred_at${tzModifier}) AS time, type, COUNT(*) AS n
       FROM events WHERE ${where.join(' AND ')}
       GROUP BY time, type
       ORDER BY time ASC`,
      sqlParams,
    );

    const filed = timeZone ? rebucketToZone(rows, timeZone, shift, bucket) : rows;
    res.json({ bucket, buckets: aggregateHistogramRows(filed) });
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
    // The viewer's zone, so byDay and each PR's day are local days (the
    // histogram reads the same parameter the same way).
    const tzOffsetMin = readTzOffsetMin(req);
    // Preferred over the offset: an IANA zone follows DST per date. Validated
    // where it is used (an unknown zone falls back), so it needs no check here.
    const timeZone = singleValue(req, 'tz');
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
      tzOffsetMin,
      timeZone,
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

    // Flow adherence over the same window/filters (CGLAB-617, CGLAB-618): judged/compliant
    // on the stamped step.transitioned events, aggregate + per developer.
    // Transitions are actor-attributed, so unlike the PR rows above — which
    // need the opener logic that keeps from/users out of SQL — every filter
    // that means anything to a transition pushes down plainly. `types` and
    // `itemTypes` are dropped exactly as fetchRows drops them, so one response
    // cannot contradict itself; the predicates are the adherence endpoint's,
    // so this surface and /v1/adherence agree on what counts. `model` is not
    // pushed because transitions carry no model — a By-model split here would
    // be fabrication, and the UI says so instead. Under a PR search the whole
    // block is skipped: an adherence number scoped to nothing (the search
    // supersedes the window) would be silently mislabelled next to one PR.
    let adherence: ReturnType<typeof adherenceOf> | undefined;
    let adherenceByDev: Map<string, ReturnType<typeof adherenceOf>> | undefined;
    if (prNumber == null) {
      const cf = applyEventFilters(orgId, { ...f, types: null, itemTypes: null });
      const cfWhere = `${cf.where.join(' AND ')} AND type = 'step.transitioned'`;
      const cfCase = `SUM(CASE WHEN ${JUDGED_TRANSITION} THEN 1 ELSE 0 END) AS judged,
            SUM(CASE WHEN ${COMPLIANT_TRANSITION} THEN 1 ELSE 0 END) AS compliant`;
      adherence = adherenceOf(await ctx.db.get<Record<string, unknown>>(
        `SELECT ${cfCase} FROM events WHERE ${cfWhere}`,
        cf.params,
      ));
      adherenceByDev = new Map(
        (await ctx.db.all<Record<string, unknown>>(
          `SELECT user_key, ${cfCase} FROM events WHERE ${cfWhere} GROUP BY user_key`,
          cf.params,
        )).map(r => [String(r.user_key), adherenceOf(r)]),
      );
    }

    res.json({
      period,
      ...result,
      ...(adherence ? {
        adherence,
        byDeveloper: result.byDeveloper.map(d => ({
          ...d,
          adherence: adherenceByDev!.get(d.user_key) ?? { judged: 0, compliant: 0, score: null },
        })),
      } : {}),
      previous,
    });
  }));

  // A malformed query parameter is the caller's mistake: a 400 that names it,
  // not the 500 an array reaching `.slice` or a SQL bind used to produce.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof BadQuery) { res.status(400).json({ error: err.message }); return; }
    next(err);
  });

  return router;
}
