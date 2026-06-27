import { prSizePoints, prSizeBucket, SIZE_BUCKETS, SizeBucket } from '@agenfk/core';

// One json_extract-shaped row per pr.opened / pr.updated event. Sizing fields are
// read from the server-computed shadow (the only source that knows leaf stories).
export interface PrEventRow {
  user_key: string;
  occurred_at: string;
  type: string; // 'pr.opened' | 'pr.updated'
  repo: string | null;
  pr_number: number | null;
  leaf_story: number | null;
  task: number | null;
  bug: number | null;
  model: string | null;
  harness: string | null;
}

type SizeDist = Record<SizeBucket, number>;

export interface PrOverviewResult {
  buckets: readonly SizeBucket[];
  totals: { prs: number; sizePoints: number; developers: number; medianBucket: SizeBucket | null };
  resized: { count: number; grew: number; shrank: number };
  byDay: Array<{ day: string; sizes: SizeDist; total: number }>;
  byDeveloper: Array<{ user_key: string; prs: number; sizePoints: number; sizes: SizeDist; daily: Record<string, number> }>;
  byModel: Array<{ model: string; harnesses: string[]; prs: number; sizePoints: number; sizes: SizeDist }>;
}

const emptyDist = (): SizeDist => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });
const dayOf = (iso: string): string => iso.slice(0, 10);
const pointsOf = (r: PrEventRow): number =>
  prSizePoints({ leafStory: r.leaf_story, task: r.task, bug: r.bug });

/** Optional opener-day window + model filter. The window is applied to the PR's
 *  OPEN time, not to individual events — so a PR opened before `from` is excluded
 *  even if it was re-sized within the window (the update alone must not make it
 *  look new). Pass rows fetched WITHOUT a lower time bound so true openers are
 *  visible. The model filter likewise matches the OPENER's model, so a PR re-sized
 *  by a different runtime stays attributed to whoever opened it. */
export interface PrWindow { from?: string | null; to?: string | null; model?: string | null }

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
}

// Collapse the raw event stream into one record per PR. A pr.updated never adds a
// new PR — it re-sizes the existing one. The PR is counted once, placed on its
// OPEN day at its LATEST size, and attributed to whoever OPENED it.
function resolvePrs(rows: ReadonlyArray<PrEventRow>): ResolvedPr[] {
  const groups = new Map<string, PrEventRow[]>();
  for (const r of rows) {
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
    });
  }
  return resolved;
}

export function aggregatePrOverview(rows: ReadonlyArray<PrEventRow>, window?: PrWindow): PrOverviewResult {
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  const model = window?.model ?? null;
  const prs = resolvePrs(rows).filter(pr =>
    (!from || pr.openerAt >= from)
    && (!to || pr.openerAt <= to)
    && (!model || pr.model === model),
  );

  const byDayMap = new Map<string, SizeDist>();
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
    .map(([day, sizes]) => ({ day, sizes, total: SIZE_BUCKETS.reduce((a, b) => a + sizes[b], 0) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const byDeveloper = [...devMap.entries()]
    .map(([user_key, v]) => ({ user_key, ...v }))
    .sort((a, b) => b.prs - a.prs || b.sizePoints - a.sizePoints || a.user_key.localeCompare(b.user_key));

  const byModel = [...modelMap.entries()]
    .map(([model, v]) => ({ model, prs: v.prs, sizePoints: v.sizePoints, sizes: v.sizes, harnesses: [...v.harnesses].sort() }))
    .sort((a, b) => b.prs - a.prs || a.model.localeCompare(b.model));

  return {
    buckets: SIZE_BUCKETS,
    totals: { prs: prs.length, sizePoints, developers: developers.size, medianBucket },
    resized,
    byDay,
    byDeveloper,
    byModel,
  };
}
