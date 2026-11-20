/**
 * GH-394: usage that belongs to a project but to no card reaches the hub as
 * ONE running total per project per local day, by model - never per turn
 * (BUG 9c27faf6 flooded the hub with per-turn events). The total is resent as
 * it grows, at most once per interval, and the hub keeps the latest, so a
 * resend never counts a turn twice.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent } from '@agenfk/core';
import {
  NO_CARD_EVENT, createNoCardUsageSender, fileSentState, localDayOf, memorySentState, noCardUsageByDay,
} from '../usage/noCardUsage';

let n = 0;
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const ev = (over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: `t-${++n}`, ts: at(19, 10), client: 'claude-code', sessionId: 's', model: 'claude-opus-5-5',
  input: 10, cachedInput: 150, cacheRead: 100, cacheWrite: 50, output: 20, reasoning: 0, total: 180,
  sourcePath: '/logs/s.jsonl', sourceOffset: n, projectId: 'p1', ...over,
});

/** The store's query, as the SQLite provider answers it. */
function store(events: TokenEvent[]) {
  return {
    events,
    queryTokenEvents: vi.fn(async (q: any) => events
      .filter(e => q.itemId === undefined || (q.itemId === null ? !e.itemId : e.itemId === q.itemId))
      .filter(e => q.projectId === undefined || e.projectId === q.projectId)
      .filter(e => q.since === undefined || e.ts >= q.since)
      .filter(e => q.until === undefined || e.ts < q.until)
      .sort((a, b) => a.ts.localeCompare(b.ts))),
  };
}

const HOUR = 60 * 60 * 1000;

function setup(events: TokenEvent[], over: { now?: Date; record?: (e: any) => Promise<boolean> } = {}) {
  const s = store(events);
  let now = over.now ?? new Date(2026, 10, 19, 18, 0);
  const sent: any[] = [];
  const record = vi.fn(over.record ?? (async (e: any) => { sent.push(e); return true; }));
  const state = memorySentState();
  const make = () => createNoCardUsageSender({ storage: s, record, state, now: () => now, minIntervalMs: 3 * HOUR, lookbackDays: 7 });
  return { s, sent, record, state, sender: make(), make, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('localDayOf', () => {
  it("is the installation's own calendar day, not UTC's", () => {
    expect(localDayOf(new Date(2026, 10, 19, 23, 59))).toBe('2026-11-19');
    expect(localDayOf(new Date(2026, 10, 20, 0, 1).toISOString())).toBe('2026-11-20');
  });
});

describe('noCardUsageByDay', () => {
  it('sums the turns on no card per project and local day, by model, leaving out carded turns and turns with no project', async () => {
    const s = store([
      ev({ ts: at(19, 9) }),
      ev({ ts: at(19, 23, 30), client: 'pi', model: 'qwen3.8:27b', costUsd: 0.25 }),
      ev({ ts: at(20, 0, 30) }),
      ev({ ts: at(19, 11), itemId: 'card-1' }),
      ev({ ts: at(19, 12), projectId: undefined }),
      ev({ ts: at(19, 13), projectId: 'p2', input: 7 }),
    ]);

    const days = await noCardUsageByDay(s, { since: at(19, 0) });

    const key = (d: { projectId: string; day: string }) => `${d.projectId}/${d.day}`;
    expect(days.map(key).sort()).toEqual(['p1/2026-11-19', 'p1/2026-11-20', 'p2/2026-11-19']);
    const p1 = days.find(d => key(d) === 'p1/2026-11-19')!;
    expect(p1.usage.total).toMatchObject({ turns: 2, input: 20, cacheRead: 200, cacheWrite: 100, output: 40, costUsd: 0.25, unpricedTurns: 1 });
    expect(p1.usage.byModel.map(m => `${m.client}/${m.model}`)).toEqual(['claude-code/claude-opus-5-5', 'pi/qwen3.8:27b']);
    expect(p1.lastTurnAt).toBe(at(19, 23, 30));
    expect(days.find(d => key(d) === 'p2/2026-11-19')!.usage.total.input).toBe(7);
    expect(s.queryTokenEvents).toHaveBeenCalledWith(expect.objectContaining({ itemId: null }));
  });

  it('can be narrowed to one project', async () => {
    const s = store([ev(), ev({ projectId: 'p2' })]);
    const days = await noCardUsageByDay(s, { projectId: 'p2', since: at(19, 0) });
    expect(days.map(d => d.projectId)).toEqual(['p2']);
  });
});

describe('the no-card usage sender', () => {
  it('GH-397: sends the price AgEnFK put on each turn at ingestion with the day total, apart from the reported cost', async () => {
    const { sender, sent } = setup([
      ev({ estimatedCostUsd: 0.5 }), ev({ estimatedCostUsd: 0.25 }), ev({ client: 'pi', model: 'qwen3.8:27b', costUsd: 0.1 }),
    ]);
    await sender.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.usage.total).toMatchObject({ turns: 3, costUsd: 0.1, estimatedCostUsd: 0.75, unpricedTurns: 0 });
    expect(sent[0].payload.usage.byModel.find((m: any) => m.model === 'claude-opus-5-5')).toMatchObject({ estimatedCostUsd: 0.75 });
  });

  it('sends one running total per project per local day, not one event per turn', async () => {
    const turns = Array.from({ length: 40 }, (_, i) => ev({ ts: at(19, 9, i) }));
    const { sender, sent } = setup([...turns, ev({ ts: at(19, 10), projectId: 'p2' })]);

    expect(await sender.tick()).toBe(2);

    expect(sent).toHaveLength(2);
    const p1 = sent.find(e => e.projectId === 'p1');
    expect(p1).toMatchObject({
      type: NO_CARD_EVENT,
      projectId: 'p1',
      occurredAt: at(19, 9, 39),
      payload: { day: '2026-11-19', asOf: new Date(2026, 10, 19, 18, 0).toISOString() },
    });
    expect(p1.itemId).toBeUndefined();
    expect(p1.payload.usage.total).toMatchObject({ turns: 40, input: 400 });
    expect(p1.payload.usage.byModel).toEqual([expect.objectContaining({ client: 'claude-code', model: 'claude-opus-5-5', turns: 40 })]);
  });

  it('carries totals only: no session id, turn, log path or working directory', async () => {
    const { sender, sent } = setup([ev({ sessionId: 'secret-session', turnId: 'turn-9', cwd: '/home/alice/secret' })]);
    await sender.tick();
    const text = JSON.stringify(sent);
    for (const leak of ['secret-session', 'turn-9', '/logs/s.jsonl', '/home/alice/secret']) expect(text).not.toContain(leak);
  });

  it('does not resend a total that has not changed', async () => {
    const { sender, sent, advance } = setup([ev()]);
    await sender.tick();
    advance(10 * HOUR);
    expect(await sender.tick()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('resends a grown total at most once per interval, always the whole running total', async () => {
    const { s, sender, sent, advance } = setup([ev({ ts: at(19, 9) })]);
    await sender.tick();
    s.events.push(ev({ ts: at(19, 17) }));
    advance(1 * HOUR);
    expect(await sender.tick()).toBe(0);
    s.events.push(ev({ ts: at(19, 19) }));
    advance(2 * HOUR);
    expect(await sender.tick()).toBe(1);

    expect(sent).toHaveLength(2);
    expect(sent[1].payload.usage.total).toMatchObject({ turns: 3, input: 30 });
    expect(sent[1].occurredAt).toBe(at(19, 19));
    expect(Date.parse(sent[1].payload.asOf)).toBeGreaterThan(Date.parse(sent[0].payload.asOf));
  });

  it('after a restart it remembers what it sent, so an unchanged total is not sent again', async () => {
    const { sender, sent, make } = setup([ev()]);
    await sender.tick();
    expect(await make().tick()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a total that could not be queued is tried again at the next tick, not held back by the interval', async () => {
    let ok = false;
    const sent: any[] = [];
    const { sender, advance } = setup([ev()], { record: async (e) => { if (!ok) return false; sent.push(e); return true; } });
    expect(await sender.tick()).toBe(0);
    ok = true;
    advance(60 * 1000);
    expect(await sender.tick()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends the final total of a day that ended, and a late-ingested turn of an earlier day', async () => {
    const { s, sender, sent, advance } = setup([ev({ ts: at(19, 9) })]);
    await sender.tick();
    s.events.push(ev({ ts: at(19, 23, 50) }));
    advance(8 * HOUR); // 02:00 on the 20th
    expect(await sender.tick()).toBe(1);
    expect(sent[1].payload).toMatchObject({ day: '2026-11-19' });
    expect(sent[1].payload.usage.total.turns).toBe(2);
  });

  it('looks back a bounded number of days and forgets what it sent before them', async () => {
    const { sender, sent, state } = setup([ev({ ts: at(10, 9) }), ev({ ts: at(19, 9) })]);
    state.save({ 'p1\u00002026-11-01': { fingerprint: 'x', sentAt: at(1, 12) } });
    await sender.tick();
    expect(sent.map(e => e.payload.day)).toEqual(['2026-11-19']);
    expect(Object.keys(state.load())).toEqual(['p1\u00002026-11-19']);
  });

  it('a day whose turns are all gone (a restored database) is sent again as zero, once', async () => {
    const { s, sender, sent, advance } = setup([ev({ ts: at(19, 9) })]);
    await sender.tick();
    s.events.length = 0;
    advance(4 * HOUR);
    expect(await sender.tick()).toBe(1);
    expect(sent[1]).toMatchObject({ projectId: 'p1', payload: { day: '2026-11-19' } });
    expect(sent[1].payload.usage.total).toMatchObject({ turns: 0, input: 0 });
    expect(sent[1].payload.usage.byModel).toEqual([]);
    expect(localDayOf(sent[1].occurredAt)).toBe('2026-11-19');
    advance(4 * HOUR);
    expect(await sender.tick()).toBe(0);
  });

  it('a send stamped in the future by a wrong clock does not hold back the next change', async () => {
    const { s, sender, sent, state } = setup([ev({ ts: at(19, 9) })]);
    await sender.tick();
    const [key] = Object.keys(state.load());
    state.save({ [key]: { ...state.load()[key], sentAt: new Date(2026, 10, 24).toISOString() } });
    s.events.push(ev({ ts: at(19, 17) }));
    expect(await sender.tick()).toBe(1);
    expect(sent[1].payload.usage.total.turns).toBe(2);
  });

  it('once stopped, a pass still under way queues and records nothing more', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { s, sender, sent, state } = setup([ev(), ev({ projectId: 'p2' })]);
    const read = s.queryTokenEvents.getMockImplementation()!;
    s.queryTokenEvents.mockImplementationOnce(async (q: any) => { await gate; return read(q); });
    const pass = sender.tick();
    const stopping = sender.stop();
    release();
    await stopping;
    expect(await pass).toBe(0);
    expect(sent).toHaveLength(0);
    expect(state.load()).toEqual({});
    expect(await sender.tick()).toBe(0);
  });

  it('stopped while a total is being queued, it does not record what it sent, leaving that to the next sender', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const sent: any[] = [];
    const { sender, state } = setup([ev()], { record: async (e) => { sent.push(e); await gate; return true; } });
    const pass = sender.tick();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const stopping = sender.stop();
    release();
    await stopping;
    expect(await pass).toBe(1);
    expect(state.load()).toEqual({});
  });

  it('a failing store read is logged, and the sender keeps going', async () => {
    const { s, sender } = setup([ev()]);
    s.queryTokenEvents.mockRejectedValueOnce(new Error('database is locked'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sender.tick()).toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
    err.mockRestore();
    expect(await sender.tick()).toBe(1);
  });
});

describe('fileSentState', () => {
  it('keeps what was sent across instances, and reads a missing or broken file as nothing sent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-no-card-state-'));
    try {
      const file = path.join(dir, 'sub', 'no-card-usage.json');
      expect(fileSentState(file).load()).toEqual({});
      fileSentState(file).save({ k: { fingerprint: 'f', sentAt: 't' } });
      expect(fileSentState(file).load()).toEqual({ k: { fingerprint: 'f', sentAt: 't' } });
      fs.writeFileSync(file, '{not json');
      expect(fileSentState(file).load()).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
