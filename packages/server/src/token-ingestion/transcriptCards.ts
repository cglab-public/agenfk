import * as fs from 'fs';
import * as path from 'path';
import type { StorageProvider, StepUsage, TokenEvent } from '@agenfk/core';
import { aggregateUsage, computeCardUsage } from '../usage/stepUsage';

export interface TranscriptCard {
  itemId: string | null;
  projectId?: string;
}

export const isSubagentLog = (p: string) => path.basename(path.dirname(p)) === 'subagents';
/** `<dir>/<session>/subagents/agent-<id>.jsonl` belongs to `<dir>/<session>.jsonl`. */
export const parentLogOf = (p: string) => (isSubagentLog(p) ? `${path.dirname(path.dirname(p))}.jsonl` : p);
/** The subagent whose transcript is at this path, '' for the session's own. */
export const agentIdOf = (p: string) => (isSubagentLog(p) ? path.basename(p, '.jsonl').replace(/^agent-/, '') : '');

/** The log of a subagent of the same session, beside `subagentLog`; '' for the session's own. */
export const siblingLogOf = (subagentLog: string, agentId: string) =>
  (agentId ? path.join(path.dirname(subagentLog), `agent-${agentId}.jsonl`) : parentLogOf(subagentLog));

const spawners = new Map<string, string>();
const SPAWNER_CACHE_MAX = 10_000;

/**
 * GH-400: the subagent that spawned the subagent whose log is `subagentLog`,
 * '' when the session itself did (or it cannot be told). The harness records it
 * as `parentAgentId` in `agent-<id>.meta.json` beside the log, written at
 * spawn and never changed, so an answer read once is kept.
 */
export async function spawnerOf(subagentLog: string): Promise<string> {
  if (!isSubagentLog(subagentLog)) return '';
  const metaPath = subagentLog.replace(/\.jsonl$/, '.meta.json');
  const known = spawners.get(metaPath);
  if (known !== undefined) return known;
  let spawner = '';
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    if (typeof meta?.parentAgentId === 'string' && /^[\w-]{1,64}$/.test(meta.parentAgentId)) spawner = meta.parentAgentId;
  } catch {
    return ''; // Not there (yet) or unreadable: not cached, so a later read can still find it.
  }
  if (spawners.size >= SPAWNER_CACHE_MAX) spawners.clear();
  spawners.set(metaPath, spawner);
  return spawner;
}

/** GH-400: the subagents above this one, nearest first, up to the session (loops cut). */
export async function spawnChainOf(subagentLog: string): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set([agentIdOf(subagentLog)]);
  for (let log = subagentLog, id = await spawnerOf(log); id && !seen.has(id); id = await spawnerOf(log)) {
    seen.add(id);
    chain.push(id);
    log = siblingLogOf(subagentLog, id);
  }
  return chain;
}

/**
 * GH-398: the card a turn's own transcript was on, in a session with subagents.
 *
 * A subagent goes by its own latest claim (a close after it means no card).
 * Before its first claim it was already working towards that card, so it is
 * charged there from its first turn. Only a subagent that never claims one (a
 * reviewer, an explorer) helps the agent that spawned it and inherits that
 * agent's card at the time (`inherited`; `from` is whose transcript decided,
 * '' for the session's own): GH-400, a helper spawned by a subagent goes by
 * that subagent, up the spawn chain, then the session. The parent goes by its
 * own claims, and a claim of its subagents on the same card ends its own: it
 * handed the card over.
 *
 * `sourcePath` (the turn's log) is where the spawn chain is read from; without
 * it a subagent with no claim inherits the session's card.
 */
export async function transcriptCardOf(
  storage: StorageProvider, client: string, sessionId: string, agentId: string, ts: string, sourcePath?: string,
): Promise<{ card: TranscriptCard | null; inherited: boolean; from: string }> {
  const chain = agentId ? [agentId, ...(sourcePath && isSubagentLog(sourcePath) ? await spawnChainOf(sourcePath) : [])] : [];
  for (const id of chain) {
    const own = await storage.transcriptCardAt(client, sessionId, id, ts);
    if (own) return { card: own, inherited: id !== agentId, from: id };
    const first = await storage.firstTranscriptClaim(client, sessionId, id);
    if (first) {
      return { card: { itemId: first.itemId, ...(first.projectId ? { projectId: first.projectId } : {}) }, inherited: id !== agentId, from: id };
    }
  }
  return { card: await storage.transcriptCardAt(client, sessionId, '', ts), inherited: !!agentId, from: '' };
}

/** Charges a stored turn to `card` if it is on another; returns whether it moved. */
export async function chargeStoredTurn(
  storage: StorageProvider, ev: TokenEvent, card: TranscriptCard | null, touched: Set<string>,
): Promise<boolean> {
  const was = ev.itemId ?? null;
  const now = card?.itemId ?? null;
  if (now === was) return false;
  await storage.setTokenEventItem(ev.id, now, now ? card?.projectId ?? ev.projectId ?? null : undefined);
  if (was) touched.add(was);
  if (now) touched.add(now);
  return true;
}

/**
 * GH-398: the stored turns a newly read claim changes, charged again.
 *
 * Ingestion is incremental, so a claim can be read after turns it decides:
 * a subagent's turns before its first claim (charged then to its parent's
 * card), and any turn of the session from the claim on (a parent's turns on
 * the card it handed over, a helper's inheriting from it). Charging again is
 * idempotent: a turn already on the right card is left alone. The cards that
 * gained or lost turns are added to `touched`, for the caller to recompute their
 * stored usage once the turns it is about to store are in.
 */
export async function rechargeAfterClaims(
  storage: StorageProvider, client: TokenEvent['client'], claims: Array<{ sessionId: string; agentId: string; at: string }>,
  touched: Set<string>,
): Promise<number> {
  const bySession = new Map<string, Array<{ agentId: string; atMs: number }>>();
  for (const c of claims) {
    const atMs = Date.parse(c.at);
    if (!Number.isFinite(atMs)) continue;
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId)!.push({ agentId: c.agentId, atMs });
  }
  let moved = 0;
  for (const [sessionId, sessionClaims] of bySession) {
    const sinceMs = Math.min(...sessionClaims.map((c) => c.atMs));
    const handOver = sessionClaims.some((c) => c.agentId !== '');
    const firstClaimers = new Set<string>();
    for (const agentId of new Set(sessionClaims.map((c) => c.agentId))) {
      if (!agentId) continue;
      const first = await storage.firstTranscriptClaim(client, sessionId, agentId);
      const firstMs = first ? Date.parse(first.at) : NaN;
      if (sessionClaims.some((c) => c.agentId === agentId && c.atMs === firstMs)) firstClaimers.add(agentId);
    }
    const since = new Date(sinceMs).toISOString();
    const events = await storage.queryTokenEvents({ client, sessionId, ...(firstClaimers.size ? {} : { since }) });
    for (const ev of events) {
      const agentId = agentIdOf(ev.sourcePath);
      // Before the claims: a first claimer's turns, and those of the helpers it spawned (GH-400).
      const affected = ev.ts >= since
        ? (agentId !== '' || handOver)
        : agentId !== '' && (firstClaimers.has(agentId) || (await spawnChainOf(ev.sourcePath)).some((a) => firstClaimers.has(a)));
      if (!affected) continue;
      const { card } = await transcriptCardOf(storage, client, sessionId, agentId, ev.ts, ev.sourcePath);
      if (await chargeStoredTurn(storage, ev, card, touched)) moved++;
    }
  }
  return moved;
}

/**
 * The stored usage of these cards, and the close totals of their ancestors,
 * from the turns as they are charged now. Returns how many cards changed.
 */
export async function recomputeStoredUsage(storage: StorageProvider, itemIds: Iterable<string>): Promise<number> {
  const withAncestors: string[] = [];
  for (const id of itemIds) {
    let cur: any = await storage.getItem(id);
    while (cur && !withAncestors.includes(cur.id)) {
      withAncestors.push(cur.id);
      cur = cur.parentId ? await storage.getItem(cur.parentId) : null;
    }
  }
  let written = 0;
  for (const id of withAncestors) {
    const item: any = await storage.getItem(id);
    if (!item) continue;
    const rows: StepUsage[] = item.usageByStep ?? [];
    if (rows.length) {
      const usageByStep: StepUsage[] = [];
      for (const row of rows) {
        const events = await storage.queryTokenEvents({ itemId: id, since: row.enteredAt, until: row.leftAt });
        usageByStep.push({ ...row, ...aggregateUsage(events) });
      }
      await storage.updateItem(id, { usageByStep } as any);
    }
    if (item.cardUsage) {
      const cardUsage = await computeCardUsage(storage, id, item.cardUsage.complete !== false, null, item.cardUsage.atStatus);
      await storage.updateItem(id, { cardUsage } as any);
    }
    if (rows.length || item.cardUsage) written++;
  }
  return written;
}
