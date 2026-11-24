import * as fs from 'fs';
import * as path from 'path';
import { PRICES_URL, parsePrices, type PriceEntry, type PricesData } from '@agenfk/core';

/** The local server's copy of the public price table (GH-397). */
export interface PriceTable {
  /** The table to price with now, or null when there has never been a good one. */
  get(): Promise<PricesData | null>;
  /** The table already at hand (the saved file once loaded, or a fetched one), never fetching. */
  cached(): PricesData | null;
  /** Read the saved file now, without fetching, so cached() has it. */
  load(): Promise<void>;
}

/** Reads the raw table; aborts when `signal` does. */
export type FetchPriceTable = (signal: AbortSignal) => Promise<unknown>;

interface Saved {
  fetchedAt: string;
  prices: PriceEntry[];
}

const HOUR = 60 * 60 * 1000;

/** The public table over HTTPS. */
export const fetchPublicPriceTable: FetchPriceTable = async (signal) => {
  const res = await fetch(PRICES_URL, { signal });
  if (!res.ok) throw new Error(`price table: HTTP ${res.status}`);
  return res.json();
};

/**
 * The price table ingestion prices turns from. Fetched with a strict timeout
 * and kept in memory and in `file` with the time it was fetched, so a restart
 * or an offline spell prices from the last good table. A table older than
 * `maxAgeMs` is fetched again; a failed fetch is not tried again for
 * `retryMs`, so an offline machine does not wait on the timeout every pass.
 * A malformed or empty answer never replaces a good table. With no fetch
 * (tests), only the saved file is read.
 */
export function createPriceTable(opts: {
  file: string | null;
  fetchTable: FetchPriceTable | null;
  now?: () => Date;
  timeoutMs?: number;
  maxAgeMs?: number;
  retryMs?: number;
}): PriceTable {
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxAgeMs = opts.maxAgeMs ?? 6 * HOUR;
  const retryMs = opts.retryMs ?? 10 * 60 * 1000;
  let current: Saved | null = null;
  let loading: Promise<void> | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const load = async () => {
    if (!opts.file) return;
    try {
      const raw = JSON.parse(await fs.promises.readFile(opts.file, 'utf8'));
      const prices = parsePrices(raw).prices ?? [];
      if (prices.length && typeof raw?.fetchedAt === 'string') current = { fetchedAt: raw.fetchedAt, prices };
    } catch { /* none saved, or unreadable: no table yet */ }
  };

  const save = async (saved: Saved) => {
    if (!opts.file) return;
    try {
      await fs.promises.mkdir(path.dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(saved));
      await fs.promises.rename(tmp, opts.file);
    } catch (e) {
      console.error(`[USAGE] could not save the price table: ${(e as Error).message}`);
    }
  };

  const refresh = async (fetchTable: FetchPriceTable) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`no answer in ${timeoutMs} ms`)); }, timeoutMs);
      timer.unref?.();
    });
    try {
      const raw = await Promise.race([fetchTable(controller.signal), timedOut]);
      const prices = parsePrices(raw).prices ?? [];
      if (!prices.length) throw new Error('the answer held no usable prices');
      current = { fetchedAt: now().toISOString(), prices };
      await save(current);
    } catch (e) {
      failedAt = now().getTime();
      console.error(`[USAGE] could not fetch the price table${current ? ', pricing from the one fetched ' + current.fetchedAt : ''}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const view = (): PricesData | null => (current ? { prices: current.prices, fetchedAt: current.fetchedAt } : null);
  return {
    cached: view,
    load: () => (loading ??= load()),
    async get() {
      await (loading ??= load());
      const at = now().getTime();
      const stale = !current || at - Date.parse(current.fetchedAt) > maxAgeMs;
      if (opts.fetchTable && stale && at - failedAt > retryMs) {
        inFlight ??= refresh(opts.fetchTable).finally(() => { inFlight = null; });
        await inFlight;
      }
      return view();
    },
  };
}
