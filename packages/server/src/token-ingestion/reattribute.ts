import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Status, isBoundaryStep } from '@agenfk/core';
import type { StorageProvider, TokenEvent } from '@agenfk/core';
import { parseClaudeCodeJsonl, hasSubagents } from './parsers/claude-code';
import { CardRefs, recordClaims, type ParserContext } from './watcher';
import {
  agentIdOf, chargeStoredTurn, isSubagentLog, parentLogOf, rechargeAfterClaims, recomputeStoredUsage, siblingLogOf, spawnerOf, transcriptCardOf,
  type TranscriptCard,
} from './transcriptCards';

/** The marker the one-off re-attribution leaves in the ingestion meta. */
export const REATTRIBUTION_MIGRATION = 'migration:gh398_subagent_attribution:v1';
/** The marker of GH-400's one-off pass over the turns of helpers spawned by a subagent. */
export const NESTED_HELPER_MIGRATION = 'migration:gh400_nested_helper_attribution:v1';

export interface ReattributionReport {
  skipped: boolean;
  /** Claude Code sessions with subagents whose turns were charged again. */
  sessions: number;
  /** Turns moved to the card their own transcript was on (or to none). */
  moved: number;
  /** Turns taken off their card because their transcript is no longer on disk. */
  cleared: number;
  /** Cards whose stored usage (step rows, close total) was recomputed. */
  cardsRecomputed: number;
}

const LINES_PER_SLICE = 2000;

type RecordedClaim = { sessionId: string; agentId: string; at: string };

/** Every claim a transcript on disk makes, recorded (the new ones added to `fresh`); false when it cannot be read. */
async function readClaims(storage: StorageProvider, file: string, cards: CardRefs, fresh?: RecordedClaim[]): Promise<boolean> {
  let stream: fs.ReadStream;
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return false;
  }
  const ctx: ParserContext = {};
  const flush = async (lines: string[]) => {
    ctx.claims = [];
    parseClaudeCodeJsonl(lines.join('\n') + '\n', file, 0, ctx);
    const recorded = await recordClaims(storage, 'claude-code', ctx.claims, cards);
    fresh?.push(...recorded);
  };
  try {
    let batch: string[] = [];
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      batch.push(line);
      if (batch.length >= LINES_PER_SLICE) { await flush(batch); batch = []; }
    }
    if (batch.length) await flush(batch);
    return true;
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
}

/** Reads each transcript for its claims once; answers whether it could be read. */
function claimsReader(storage: StorageProvider, cards: CardRefs, fresh?: RecordedClaim[]) {
  const readable = new Map<string, boolean>();
  return async (file: string): Promise<boolean> => {
    if (!readable.has(file)) readable.set(file, await readClaims(storage, file, cards, fresh));
    return !!readable.get(file);
  };
}

/** Closes made before card_closes existed: every move of a card to DONE or to its flow's final step. */
async function backfillCloses(storage: StorageProvider): Promise<void> {
  const finalStep = new Map<string, string | null>();
  for (const project of await storage.listProjects()) {
    const flow = project.flowId ? await storage.getFlow(project.flowId) : null;
    const steps = [...(flow?.steps ?? [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const last = steps[steps.length - 1];
    finalStep.set(project.id, last && isBoundaryStep(last) ? last.name : null);
  }
  for (const item of await storage.listItems()) {
    const exit = finalStep.get(item.projectId) ?? null;
    for (const h of item.history ?? []) {
      const to = String(h.toStatus);
      if (to !== Status.DONE && to !== exit) continue;
      const at = new Date(h.timestamp as any);
      if (Number.isFinite(at.getTime())) await storage.recordCardClose(item.id, at.toISOString());
    }
  }
}

/**
 * GH-398: charge the turns stored under the old rule again, once.
 *
 * Only Claude Code sessions with subagents were charged wrongly: every
 * subagent's gatekeeper and verify wrote the journal under its parent's
 * session id. Their transcripts are read again for their claims, and each of
 * their turns is charged by the corrected rule (see transcriptCardOf). A
 * turn whose transcript is gone - or, for a subagent that never claims a card,
 * whose parent's transcript is gone - cannot be re-derived: it is
 * taken off its card rather than left on a guess, and stays counted for its
 * project as usage on no card. The cards that gained or lost turns have their
 * stored usage recomputed. Runs once; `force` runs it again.
 */
export async function reattributeSubagentUsage(
  storage: StorageProvider,
  opts: { force?: boolean; log?: (message: string) => void } = {},
): Promise<ReattributionReport> {
  const report: ReattributionReport = { skipped: false, sessions: 0, moved: 0, cleared: 0, cardsRecomputed: 0 };
  if (!opts.force && await storage.getIngestionMeta(REATTRIBUTION_MIGRATION)) return { ...report, skipped: true };

  await backfillCloses(storage);
  const bySession = new Map<string, TokenEvent[]>();
  for (const ev of await storage.queryTokenEvents({ client: 'claude-code' })) {
    if (!ev.sessionId) continue;
    if (!bySession.has(ev.sessionId)) bySession.set(ev.sessionId, []);
    bySession.get(ev.sessionId)!.push(ev);
  }

  const cards = new CardRefs(storage);
  const touched = new Set<string>();
  for (const [sessionId, events] of bySession) {
    const parents = new Set(events.map((ev) => parentLogOf(ev.sourcePath)));
    let withSubagents = events.some((ev) => isSubagentLog(ev.sourcePath));
    for (const parent of parents) if (!withSubagents && await hasSubagents(parent)) withSubagents = true;
    if (!withSubagents) continue;
    report.sessions++;

    // Every claim first: a turn is charged by claims read from any transcript of its session.
    const readableLog = claimsReader(storage, cards);
    for (const file of new Set([...parents, ...events.map((ev) => ev.sourcePath)])) await readableLog(file);

    for (const ev of events) {
      let derivable = await readableLog(ev.sourcePath);
      let card: TranscriptCard | null = null;
      if (derivable) {
        const charged = await transcriptCardOf(storage, 'claude-code', sessionId, agentIdOf(ev.sourcePath), ev.ts, ev.sourcePath);
        derivable = !charged.inherited || await readableLog(siblingLogOf(ev.sourcePath, charged.from));
        card = charged.card;
      }
      if (!await chargeStoredTurn(storage, ev, derivable ? card : null, touched)) continue;
      if (derivable) report.moved++;
      else report.cleared++;
    }
  }

  report.cardsRecomputed = await recomputeStoredUsage(storage, touched);
  await storage.setIngestionMeta(REATTRIBUTION_MIGRATION, JSON.stringify({ ...report, at: new Date().toISOString() }));
  (opts.log ?? console.log)(
    `[USAGE] GH-398 re-attribution: re-read ${report.sessions} session(s) with subagents; `
    + `moved ${report.moved} turn(s) to the card their own transcript was on, `
    + `took ${report.cleared} turn(s) off their card because their transcript is gone (still counted for their project), `
    + `recomputed the stored usage of ${report.cardsRecomputed} card(s). `
    + 'Usage already sent to the hub is not rewritten from here.',
  );
  return report;
}

export interface NestedHelperReport {
  skipped: boolean;
  /** Turns of helpers spawned by a subagent moved to the card the spawn chain gives them. */
  moved: number;
  /** Cards whose stored usage (step rows, close total) was recomputed. */
  cardsRecomputed: number;
}

/**
 * GH-400: charge again, once, the stored turns of helpers spawned by a subagent.
 *
 * GH-398's pass charged a subagent that never claims a card to the session's
 * card, so a helper spawned by a subagent missed the card that subagent was
 * on (often to no card, once the session had handed its card over). Only those
 * helpers' turns are charged again here, by the spawn chain their
 * `agent-<id>.meta.json` records, with the claims of the session's transcripts
 * read again. Unlike GH-398's pass this one only moves turns onto a card: a
 * turn is left where it is when its own transcript, its meta file or the
 * transcript it would inherit from is gone, since turns charged right by
 * GH-398 may have outlived their logs since, and when the rule gives no card.
 * A claim this pass is the first to record (written after the last ingestion
 * pass) re-charges the turns it decides here, as ingestion would have: it will
 * not be new to ingestion any more. Runs once; `force` runs it again.
 */
export async function reattributeNestedHelpers(
  storage: StorageProvider,
  opts: { force?: boolean; log?: (message: string) => void } = {},
): Promise<NestedHelperReport> {
  const report: NestedHelperReport = { skipped: false, moved: 0, cardsRecomputed: 0 };
  if (!opts.force && await storage.getIngestionMeta(NESTED_HELPER_MIGRATION)) return { ...report, skipped: true };

  const nested = new Map<string, TokenEvent[]>();
  for (const ev of await storage.queryTokenEvents({ client: 'claude-code' })) {
    if (!ev.sessionId || !isSubagentLog(ev.sourcePath) || !await spawnerOf(ev.sourcePath)) continue;
    if (!nested.has(ev.sessionId)) nested.set(ev.sessionId, []);
    nested.get(ev.sessionId)!.push(ev);
  }

  const cards = new CardRefs(storage);
  const touched = new Set<string>();
  // Claims this pass is first to read: ingestion will not see them as new, so they are acted on here.
  const fresh: RecordedClaim[] = [];
  for (const [sessionId, events] of nested) {
    const readableLog = claimsReader(storage, cards, fresh);
    // Every transcript of the session claims cards a helper may inherit; read them before charging any.
    const dir = path.dirname(events[0].sourcePath);
    await readableLog(parentLogOf(events[0].sourcePath));
    for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (/^agent-[\w-]+\.jsonl$/.test(name)) await readableLog(path.join(dir, name));
    }
    for (const ev of events) {
      if (!await readableLog(ev.sourcePath)) continue;
      const charged = await transcriptCardOf(storage, 'claude-code', sessionId, agentIdOf(ev.sourcePath), ev.ts, ev.sourcePath);
      if (charged.inherited && !await readableLog(siblingLogOf(ev.sourcePath, charged.from))) continue;
      if (!charged.card?.itemId) continue; // Only ever onto a card: a turn GH-398 charged is not taken off one.
      if (await chargeStoredTurn(storage, ev, charged.card, touched)) report.moved++;
    }
  }
  report.moved += await rechargeAfterClaims(storage, 'claude-code', fresh, touched);

  report.cardsRecomputed = await recomputeStoredUsage(storage, touched);
  await storage.setIngestionMeta(NESTED_HELPER_MIGRATION, JSON.stringify({ ...report, at: new Date().toISOString() }));
  (opts.log ?? console.log)(
    `[USAGE] GH-400 re-attribution: moved ${report.moved} turn(s) of helpers spawned by a subagent to the card `
    + `that subagent was on, recomputed the stored usage of ${report.cardsRecomputed} card(s). `
    + 'Usage already sent to the hub is not rewritten from here.',
  );
  return report;
}
