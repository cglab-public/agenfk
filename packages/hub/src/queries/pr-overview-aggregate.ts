import { prSizePoints, prSizeBucket, SIZE_BUCKETS, SizeBucket } from '@agenfk/core';
import { resolveModelId, ModelMapping, EMPTY_MODEL_MAPPING } from '../util/modelMapping';
import type { ModelMeta } from '../util/modelMeta';
import { prUrlFor } from '../util/remoteUrl.js';

// One json_extract-shaped row per pr.opened / pr.updated event. Sizing fields are
// read from the server-computed shadow (the only source that knows leaf stories).
//
// Field types intentionally allow both backends' shapes: SQLite returns TEXT
// (string) timestamps and INTEGER numerics, while Postgres returns TIMESTAMPTZ as
// a JS Date and jsonb_extract_path_text numerics as strings. normaliseRow()
// reconciles them before any aggregation.
export interface PrEventRow {
  user_key: string;
  occurred_at: string | Date;
  type: string; // 'pr.opened' | 'pr.updated'
  repo: string | null;
  pr_number: number | string | null;
  leaf_story: number | string | null;
  task: number | string | null;
  bug: number | string | null;
  model: string | null;
  harness: string | null;
  // CGLAB-131: the event's canonical git remote (written at ingest). The
  // drill-down link is derived from the OPENER's row, not the latest one.
  remote_url: string | null;
}

// Normalised, backend-agnostic event used internally.
interface NormRow {
  user_key: string;
  occurred_at: string; // ISO-8601 UTC
  type: string;
  repo: string | null;
  pr_number: string | null;
  leafStory: number;
  task: number;
  bug: number;
  model: string | null;
  harness: string | null;
  remoteUrl: string | null;
}

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString()
    : typeof v === 'string' ? v
      : new Date(v as never).toISOString();

const toNum = (v: unknown): number => {
  const n = v == null ? 0 : typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function normaliseRow(r: PrEventRow, mapping: ModelMapping): NormRow {
  return {
    user_key: r.user_key,
    occurred_at: toIso(r.occurred_at),
    type: r.type,
    repo: r.repo,
    pr_number: r.pr_number == null ? null : String(r.pr_number),
    leafStory: toNum(r.leaf_story),
    task: toNum(r.task),
    bug: toNum(r.bug),
    // Resolved here, at the single funnel both the grouping and the filter read
    // through, so the two can never disagree about a PR's model.
    model: resolveModelId(r.model, mapping),
    harness: r.harness,
    remoteUrl: r.remote_url ?? null,
  };
}

type SizeDist = Record<SizeBucket, number>;

export interface PrOverviewResult {
  buckets: readonly SizeBucket[];
  totals: { prs: number; sizePoints: number; developers: number; medianBucket: SizeBucket | null };
  resized: { count: number; grew: number; shrank: number };
  byDay: Array<{
    day: string;
    sizes: SizeDist;
    total: number;
    // Per-size developer breakdown for slice tooltips: devBySize[size] = the
    // developers who opened a PR of that size on that day, with their counts.
    devBySize: Record<SizeBucket, Array<{ user_key: string; count: number }>>;
  }>;
  byDeveloper: Array<{ user_key: string; prs: number; sizePoints: number; sizes: SizeDist; daily: Record<string, number> }>;
  byModel: Array<{
    model: string; harnesses: string[]; prs: number; sizePoints: number; sizes: SizeDist;
    // Provider + license class from the admin-editable model_meta table, so the
    // PR Overview can filter models by them without the browser holding a seed.
    // `provider: 'unclassified'` when no row matches — surfaced, never guessed.
    provider?: string;
    licenseClass?: 'open_weights' | 'commercial';
    license?: string;
  }>;
  // CGLAB-131 drill-down: the resolved PR set itself — one entry per PR with
  // opener attribution and the LATEST sizing, exactly the set the heatmap
  // cells and the totals count. Ordered by open time, then repo#number.
  // `url` is a GitHub link or null (non-GitHub host / unparseable — the UI
  // then shows "repo #N" without a link rather than a guess).
  prs: Array<{
    repo: string;
    prNumber: number;
    url: string | null;
    user_key: string;
    model: string;
    harness: string | null;
    openedAt: string;
    day: string;
    points: number;
    bucket: SizeBucket;
  }>;
}

const emptyDist = (): SizeDist => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });
const dayOf = (iso: string): string => iso.slice(0, 10);
const pointsOf = (r: NormRow): number =>
  prSizePoints({ leafStory: r.leafStory, task: r.task, bug: r.bug });

/** Optional opener-day window + model filter. The window is applied to the PR's
 *  OPEN time, not to individual events — so a PR opened before `from` is excluded
 *  even if it was re-sized within the window (the update alone must not make it
 *  look new). Pass rows fetched WITHOUT a lower time bound so true openers are
 *  visible. The model filter likewise matches the OPENER's model, so a PR re-sized
 *  by a different runtime stays attributed to whoever opened it. `models` is
 *  match-any (multi-select): a PR is kept when its opener's model is ANY of the
 *  listed ones; an empty/absent list means no filter (all models). The developer
 *  filter is likewise opener-based — a PR opened by X but re-sized by Y still
 *  belongs to X, so filtering by Y must not pull it in. */
export interface PrWindow {
  from?: string | null;
  to?: string | null;
  models?: string[] | null;
  developers?: string[] | null;
  /**
   * Admin alias -> canonical model name. Applied to stored ids AND to `models`
   * above, so both sides of the filter compare canonical names. Callers pass
   * already-resolved `models` if they resolved them themselves.
   */
  modelMapping?: ModelMapping | null;
  /**
   * Provider + license class per model id, from the admin-editable model_meta
   * table. Keyed by the model id as it appears in `byModel` (i.e. after alias
   * resolution), which is why the caller resolves aliases first and looks up
   * the canonical name here.
   */
  modelMeta?: ReadonlyMap<string, ModelMeta> | null;
}

interface ResolvedPr {
  user_key: string;
  model: string;
  harness: string | null;
  openerAt: string;
  day: string;
  points: number;       // latest sizing
  bucket: SizeBucket;   // from latest sizing
  openerPoints: number; // first sizing
  events: number;
  // CGLAB-131 drill-down fields (opener-identified, for the link + list).
  repo: string;
  prNumber: number;
  url: string | null;   // GitHub link or null (non-GitHub host / unparseable)
}

// Collapse the raw event stream into one record per PR. A pr.updated never adds a
// new PR — it re-sizes the existing one. The PR is counted once, placed on its
// OPEN day at its LATEST size, and attributed to whoever OPENED it.
function resolvePrs(rows: ReadonlyArray<PrEventRow>, mapping: ModelMapping): ResolvedPr[] {
  const groups = new Map<string, NormRow[]>();
  for (const raw of rows) {
    const r = normaliseRow(raw, mapping);
    if (!r.repo || r.pr_number == null) continue; // not a sizeable PR event
    const key = `${r.repo}#${r.pr_number}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }

  const resolved: ResolvedPr[] = [];
  for (const events of groups.values()) {
    const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    // Opener: the pr.opened event if present, else the earliest event.
    const opener = sorted.find(e => e.type === 'pr.opened') ?? sorted[0];
    const latest = sorted[sorted.length - 1];
    const points = pointsOf(latest);
    // The link follows the OPENER (same attribution rule as user/model/day):
    // a later re-size from another machine must not re-home the PR's repo host.
    resolved.push({
      user_key: opener.user_key,
      model: opener.model ?? 'unknown',
      harness: opener.harness ?? null,
      openerAt: opener.occurred_at,
      day: dayOf(opener.occurred_at),
      points,
      bucket: prSizeBucket(points),
      openerPoints: pointsOf(opener),
      events: sorted.length,
      repo: opener.repo!,
      prNumber: Number(opener.pr_number),
      url: prUrlFor(opener.remoteUrl, opener.repo, Number(opener.pr_number)),
    });
  }
  return resolved;
}

export function aggregatePrOverview(rows: ReadonlyArray<PrEventRow>, window?: PrWindow): PrOverviewResult {
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  const mapping = window?.modelMapping ?? EMPTY_MODEL_MAPPING;
  const modelFilter = window?.models && window.models.length
    ? new Set(window.models.map(m => resolveModelId(m, mapping) as string))
    : null;
  const devFilter = window?.developers && window.developers.length ? new Set(window.developers) : null;
  const prs = resolvePrs(rows, mapping).filter(pr =>
    (!from || pr.openerAt >= from)
    && (!to || pr.openerAt <= to)
    && (!modelFilter || modelFilter.has(pr.model))
    && (!devFilter || devFilter.has(pr.user_key)),
  );

  const byDayMap = new Map<string, SizeDist>();
  // day → size bucket → (developer → count), for slice tooltips.
  const dayDevMap = new Map<string, Record<SizeBucket, Map<string, number>>>();
  const devMap = new Map<string, { prs: number; sizePoints: number; sizes: SizeDist; daily: Record<string, number> }>();
  const modelMap = new Map<string, { prs: number; sizePoints: number; sizes: SizeDist; harnesses: Set<string> }>();
  const resized = { count: 0, grew: 0, shrank: 0 };
  const developers = new Set<string>();
  let sizePoints = 0;

  for (const pr of prs) {
    sizePoints += pr.points;
    developers.add(pr.user_key);

    const day = byDayMap.get(pr.day) ?? emptyDist();
    day[pr.bucket]++;
    byDayMap.set(pr.day, day);

    let dayDev = dayDevMap.get(pr.day);
    if (!dayDev) { dayDev = { xs: new Map(), s: new Map(), m: new Map(), l: new Map(), xl: new Map() }; dayDevMap.set(pr.day, dayDev); }
    const devCounts = dayDev[pr.bucket];
    devCounts.set(pr.user_key, (devCounts.get(pr.user_key) ?? 0) + 1);

    const dev = devMap.get(pr.user_key) ?? { prs: 0, sizePoints: 0, sizes: emptyDist(), daily: {} };
    dev.prs++; dev.sizePoints += pr.points; dev.sizes[pr.bucket]++;
    dev.daily[pr.day] = (dev.daily[pr.day] ?? 0) + 1;
    devMap.set(pr.user_key, dev);

    const mdl = modelMap.get(pr.model) ?? { prs: 0, sizePoints: 0, sizes: emptyDist(), harnesses: new Set<string>() };
    mdl.prs++; mdl.sizePoints += pr.points; mdl.sizes[pr.bucket]++;
    if (pr.harness) mdl.harnesses.add(pr.harness);
    modelMap.set(pr.model, mdl);

    // A PR is "resized" when a later sizing differs from the opener's.
    if (pr.events > 1 && pr.points !== pr.openerPoints) {
      resized.count++;
      if (pr.points > pr.openerPoints) resized.grew++; else resized.shrank++;
    }
  }

  // Median bucket across all PRs (ordinal on the XS–XL ramp). For an even count
  // we take the lower of the two central buckets (no averaging — buckets are
  // ordinal, not numeric).
  let medianBucket: SizeBucket | null = null;
  if (prs.length) {
    const idx = prs.map(p => SIZE_BUCKETS.indexOf(p.bucket)).sort((a, b) => a - b);
    medianBucket = SIZE_BUCKETS[idx[Math.floor((idx.length - 1) / 2)]];
  }

  const byDay = [...byDayMap.entries()]
    .map(([day, sizes]) => {
      const dayDev = dayDevMap.get(day);
      const devBySize = {} as Record<SizeBucket, Array<{ user_key: string; count: number }>>;
      for (const b of SIZE_BUCKETS) {
        const m = dayDev?.[b];
        devBySize[b] = m
          ? [...m.entries()]
            .map(([user_key, count]) => ({ user_key, count }))
            .sort((x, y) => y.count - x.count || x.user_key.localeCompare(y.user_key))
          : [];
      }
      return { day, sizes, total: SIZE_BUCKETS.reduce((a, b) => a + sizes[b], 0), devBySize };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  const byDeveloper = [...devMap.entries()]
    .map(([user_key, v]) => ({ user_key, ...v }))
    .sort((a, b) => b.prs - a.prs || b.sizePoints - a.sizePoints || a.user_key.localeCompare(b.user_key));

  const byModel = [...modelMap.entries()]
    .map(([model, v]) => {
      const meta = window?.modelMeta?.get(model);
      return {
        model,
        prs: v.prs,
        sizePoints: v.sizePoints,
        sizes: v.sizes,
        harnesses: [...v.harnesses].sort(),
        // Absent when the caller did not load metadata (e.g. a test that only
        // exercises aggregation) — the UI then falls back to no meta-filter.
        ...(meta ? { provider: meta.provider, licenseClass: meta.licenseClass, license: meta.license } : {}),
      };
    })
    .sort((a, b) => b.prs - a.prs || a.model.localeCompare(b.model));

  // The drill-down list: the same resolved PRs (already window/model/dev-
  // filtered), in a stable order for the modal — open time, then repo#number.
  const prsDetail = [...prs]
    .sort((a, b) =>
      a.openerAt.localeCompare(b.openerAt)
      || `${a.repo}#${a.prNumber}`.localeCompare(`${b.repo}#${b.prNumber}`))
    .map(p => ({
      repo: p.repo,
      prNumber: p.prNumber,
      url: p.url,
      user_key: p.user_key,
      model: p.model,
      harness: p.harness,
      openedAt: p.openerAt,
      day: p.day,
      points: p.points,
      bucket: p.bucket,
    }));

  return {
    buckets: SIZE_BUCKETS,
    totals: { prs: prs.length, sizePoints, developers: developers.size, medianBucket },
    resized,
    byDay,
    byDeveloper,
    byModel,
    prs: prsDetail,
  };
}
