/**
 * GH-397: the local server's copy of the public price table. Fetched with a
 * strict timeout, kept in memory and in a small file, so a restart or an
 * offline spell prices turns from the last good table. The tests never touch
 * the network: the fetch is injected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPriceTable } from '../token-ingestion/priceTable';

const RAW = { prices: [{ id: 'claude-opus-5-5', input: 10, output: 50, input_cached: 1 }] };
const dirs: string[] = [];
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-prices-'));
  dirs.push(d);
  return path.join(d, 'nested', 'price-table.json');
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const clock = (start = '2026-11-20T10:00:00Z') => {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
};

describe('createPriceTable', () => {
  it('fetches the table once and serves it from memory while it is fresh', async () => {
    let calls = 0;
    const c = clock();
    const table = createPriceTable({ file: tmpFile(), now: c.now, fetchTable: async () => { calls++; return RAW; } });
    expect((await table.get())?.prices?.[0].id).toBe('claude-opus-5-5');
    c.advance(60_000);
    await table.get();
    expect(calls).toBe(1);
  });

  it('writes the last good table to its file with the time it was fetched', async () => {
    const file = tmpFile();
    const table = createPriceTable({ file, now: clock().now, fetchTable: async () => RAW });
    await table.get();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.fetchedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(saved.prices[0].id).toBe('claude-opus-5-5');
  });

  it('after a restart while offline, prices from the table saved before', async () => {
    const file = tmpFile();
    await createPriceTable({ file, now: clock().now, fetchTable: async () => RAW }).get();
    const offline = createPriceTable({ file, now: clock('2026-11-25T10:00:00Z').now, fetchTable: async () => { throw new Error('offline'); } });
    const t = await offline.get();
    expect(t?.prices?.[0].id).toBe('claude-opus-5-5');
    expect(t?.fetchedAt).toBe('2026-11-20T10:00:00.000Z');
  });

  it('gives up on a fetch that hangs past the timeout and answers with what it has', async () => {
    let aborted = false;
    const table = createPriceTable({
      file: tmpFile(), now: clock().now, timeoutMs: 20,
      fetchTable: (signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }),
    });
    const started = Date.now();
    expect(await table.get()).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
  });

  it('answers on time even when the fetch ignores the abort and never settles', async () => {
    const table = createPriceTable({ file: tmpFile(), now: clock().now, timeoutMs: 20, fetchTable: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await table.get()).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('after a failure, does not try again until the retry interval has passed', async () => {
    let calls = 0;
    const c = clock();
    const table = createPriceTable({ file: tmpFile(), now: c.now, retryMs: 600_000, fetchTable: async () => { calls++; throw new Error('down'); } });
    await table.get();
    await table.get();
    expect(calls).toBe(1);
    c.advance(600_001);
    await table.get();
    expect(calls).toBe(2);
  });

  it('refreshes a table older than its maximum age, and keeps the old one when the refresh fails', async () => {
    let calls = 0;
    let fail = false;
    const c = clock();
    const table = createPriceTable({
      file: tmpFile(), now: c.now, maxAgeMs: 1000,
      fetchTable: async () => { calls++; if (fail) throw new Error('down'); return RAW; },
    });
    await table.get();
    c.advance(1001);
    fail = true;
    const t = await table.get();
    expect(calls).toBe(2);
    expect(t?.prices?.[0].id).toBe('claude-opus-5-5');
  });

  it('a malformed or empty answer does not replace the last good table', async () => {
    const file = tmpFile();
    const c = clock();
    let answer: unknown = RAW;
    const table = createPriceTable({ file, now: c.now, maxAgeMs: 1000, fetchTable: async () => answer });
    await table.get();
    answer = { prices: 'nope' };
    c.advance(1001);
    expect((await table.get())?.prices?.[0].id).toBe('claude-opus-5-5');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).prices[0].id).toBe('claude-opus-5-5');
  });

  it('concurrent reads share one fetch', async () => {
    let calls = 0;
    const table = createPriceTable({ file: tmpFile(), now: clock().now, fetchTable: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return RAW; } });
    await Promise.all([table.get(), table.get(), table.get()]);
    expect(calls).toBe(1);
  });

  it('cached() hands over the table at hand without fetching, once the saved file is loaded', async () => {
    const file = tmpFile();
    await createPriceTable({ file, now: clock().now, fetchTable: async () => RAW }).get();
    let calls = 0;
    const table = createPriceTable({ file, now: clock('2026-12-20T10:00:00Z').now, fetchTable: async () => { calls++; return RAW; } });
    expect(table.cached()).toBeNull();
    await table.load();
    expect(table.cached()?.fetchedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(calls).toBe(0);
  });

  it('with no fetch and no saved file, there is no table', async () => {
    expect(await createPriceTable({ file: tmpFile(), fetchTable: null }).get()).toBeNull();
  });

  it('an unreadable saved file is no table, not an error', async () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(await createPriceTable({ file, fetchTable: null }).get()).toBeNull();
  });
});
