import * as fs from 'fs';
import * as path from 'path';
import type { TokenEvent, TokenEventQuery, UsageSummary } from '@agenfk/core';
import { addTotals, aggregateUsage, zeroTotals } from './stepUsage';

/**
 * GH-394: usage that belongs to a project but to no card - a session before it
 * picks a card up, between cards, PR and release work.
 *
 * It reaches the hub as ONE running total per project per local day, by model:
 * the same totals shape a step carries, resent as the day grows and replaced by
 * the hub (the latest `asOf` wins), so a resend, a resend out of order or a
 * total recomputed from a restored database never counts a turn twice. Never
 * per turn: per-turn forwarding flooded the hub in beta.10 (BUG 9c27faf6).
 */
export const NO_CARD_EVENT = 'usage.no-card' as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** The installation's own calendar day of an instant, YYYY-MM-DD. */
export function localDayOf(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight `daysBack` days before `now`'s day. */
export function localMidnight(now: Date, daysBack = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** One project's usage on no card for one local day. */
export interface NoCardDay {
  projectId: string;
  day: string;
  /** The day's latest turn: when the total was last added to. */
  lastTurnAt: string;
  usage: UsageSummary;
}

type TokenReader = { queryTokenEvents(q: TokenEventQuery): Promise<TokenEvent[]> };

/** The turns on no card since `since`, per project and local day; turns with no project are left out. */
export async function noCardUsageByDay(
  storage: TokenReader,
  q: { projectId?: string; since: string; until?: string },
): Promise<NoCardDay[]> {
  const events = await storage.queryTokenEvents({
    itemId: null,
    since: q.since,
    ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
    ...(q.until !== undefined ? { until: q.until } : {}),
  });
  const groups = new Map<string, { projectId: string; day: string; lastMs: number; events: TokenEvent[] }>();
  for (const ev of events) {
    if (!ev.projectId) continue;
    const ms = Date.parse(ev.ts);
    if (!Number.isFinite(ms)) continue;
    const day = localDayOf(new Date(ms));
    const key = `${ev.projectId}\u0000${day}`;
    let g = groups.get(key);
    if (!g) { g = { projectId: ev.projectId, day, lastMs: ms, events: [] }; groups.set(key, g); }
    g.events.push(ev);
    if (ms > g.lastMs) g.lastMs = ms;
  }
  return [...groups.values()]
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.day.localeCompare(b.day))
    .map(g => ({ projectId: g.projectId, day: g.day, lastTurnAt: new Date(g.lastMs).toISOString(), usage: aggregateUsage(g.events) }));
}

/** Several summaries as one: totals added, models merged by client and model. */
export function mergeUsage(summaries: UsageSummary[]): UsageSummary {
  const total = zeroTotals();
  const byKey = new Map<string, UsageSummary['byModel'][number]>();
  for (const s of summaries) {
    addTotals(total, s.total);
    for (const m of s.byModel) {
      const key = `${m.client}\u0000${m.model}`;
      const row = byKey.get(key);
      if (row) addTotals(row, m);
      else byKey.set(key, { ...m });
    }
  }
  return { total, byModel: [...byKey.values()] };
}

/** What was last sent for a project and day: its totals' fingerprint and when. */
export type SentRecord = Record<string, { fingerprint: string; sentAt: string }>;

export interface SentState {
  load(): SentRecord;
  save(record: SentRecord): void;
}

/** Kept in memory only: a restart sends every day in the look-back again. */
export function memorySentState(): SentState {
  let record: SentRecord = {};
  return { load: () => ({ ...record }), save: (r) => { record = { ...r }; } };
}

/** Kept in a file, so a restart does not resend totals that have not changed. A missing or unreadable file is nothing sent. */
export function fileSentState(file: string): SentState {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    },
    save: (record) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, file);
    },
  };
}

/** The event the sender asks to be queued for the hub. */
export interface NoCardHubEvent {
  type: typeof NO_CARD_EVENT;
  projectId: string;
  occurredAt: string;
  payload: { day: string; asOf: string; usage: UsageSummary };
}

export interface NoCardUsageSender {
  /** Queue the totals that changed and are due; returns how many were queued. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  /** No tick after this queues or records anything; resolves once a pass under way has finished. */
  stop(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
export const NO_CARD_MIN_INTERVAL_MS = 3 * HOUR;
export const NO_CARD_TICK_MS = 15 * 60 * 1000;
export const NO_CARD_LOOKBACK_DAYS = 7;

const fingerprintOf = (u: UsageSummary) => JSON.stringify({
  total: u.total,
  byModel: [...u.byModel].sort((a, b) => `${a.client}\u0000${a.model}`.localeCompare(`${b.client}\u0000${b.model}`)),
});

/**
 * Sends each project's usage on no card per local day, for the last
 * `lookbackDays` days: a total is sent when it changed, and at most once per
 * `minIntervalMs` per project and day - a handful of events a day, whatever
 * the number of turns. A total that could not be queued is tried again at the
 * next tick.
 */
export function createNoCardUsageSender(opts: {
  storage: TokenReader;
  record: (event: NoCardHubEvent) => Promise<boolean>;
  state: SentState;
  now?: () => Date;
  minIntervalMs?: number;
  lookbackDays?: number;
}): NoCardUsageSender {
  const now = opts.now ?? (() => new Date());
  const minInterval = opts.minIntervalMs ?? NO_CARD_MIN_INTERVAL_MS;
  const lookback = opts.lookbackDays ?? NO_CARD_LOOKBACK_DAYS;
  let running: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const pass = async (): Promise<number> => {
    if (stopped) return 0;
    const at = now();
    const firstDay = localDayOf(localMidnight(at, lookback - 1));
    let days: NoCardDay[];
    try {
      days = await noCardUsageByDay(opts.storage, { since: localMidnight(at, lookback - 1).toISOString() });
    } catch (e) {
      console.error(`[USAGE] could not read the usage on no card: ${(e as Error).message}`);
      return 0;
    }
    const sent = opts.state.load();
    for (const key of Object.keys(sent)) {
      if ((key.split('\u0000')[1] ?? '') < firstDay) delete sent[key];
    }
    // A day sent before whose turns are all gone now (a restored database) is
    // sent again as zero, so the hub's last total for it does not stand.
    const current = new Set(days.map(d => `${d.projectId}\u0000${d.day}`));
    for (const key of Object.keys(sent)) {
      if (current.has(key)) continue;
      const [projectId, day] = key.split('\u0000');
      if (!projectId || !day) continue;
      const [y, m, dd] = day.split('-').map(Number);
      days.push({ projectId, day, lastTurnAt: new Date(y, m - 1, dd, 12).toISOString(), usage: { total: zeroTotals(), byModel: [] } });
    }
    let queued = 0;
    for (const d of days) {
      if (stopped) break;
      const key = `${d.projectId}\u0000${d.day}`;
      const fingerprint = fingerprintOf(d.usage);
      const prev = sent[key];
      if (prev?.fingerprint === fingerprint) continue;
      const since = at.getTime() - Date.parse(prev?.sentAt ?? '');
      // A send stamped in the future (the clock was wrong then) holds nothing back.
      if (prev && since >= 0 && since < minInterval) continue;
      const asOf = at.toISOString();
      const ok = await opts.record({
        type: NO_CARD_EVENT,
        projectId: d.projectId,
        occurredAt: d.lastTurnAt,
        payload: { day: d.day, asOf, usage: d.usage },
      }).catch(() => false);
      if (!ok) continue;
      sent[key] = { fingerprint, sentAt: asOf };
      queued++;
    }
    if (stopped) return queued;
    try {
      opts.state.save(sent);
    } catch (e) {
      console.error(`[USAGE] could not record the usage on no card sent: ${(e as Error).message}`);
    }
    return queued;
  };

  const tick = () => {
    if (!running) running = pass().finally(() => { running = null; });
    return running;
  };

  return {
    tick,
    start: (intervalMs = NO_CARD_TICK_MS) => {
      if (timer) return;
      const loop = () => {
        timer = setTimeout(() => { tick().finally(() => { if (timer) loop(); }); }, intervalMs);
        timer.unref?.();
      };
      loop();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running?.catch(() => undefined);
    },
  };
}
