/**
 * Hub receipt publisher (RFC-002, task 0334a5e6) — pushes the verification
 * receipts a card carries to the hub ONCE, and records on the card only what
 * the hub actually answered.
 *
 * A receipt is a claim another machine has to honour, so the delivery state
 * written back onto it is a promise about the hub's reply, not about our own
 * effort:
 *
 *  - `acked` only when the hub answered with a receipt id. Everything that is
 *    not that — a 5xx, a socket closed mid-request, a 200 whose body names no
 *    id — leaves the receipt `pending` with the error, so the next tick asks
 *    again. Recording a delivery that never happened is how a receipt would go
 *    missing forever with a card that says it was sent.
 *  - `rejected` only when the hub refused the receipt itself (a 4xx: the id is
 *    another receipt's, the repository is unknown, the receipt is malformed).
 *    Retrying a refusal cannot turn it into a receipt, so it is not retried —
 *    and because losing a receipt is otherwise silent, the card is told in a
 *    comment, once.
 *  - `attempts` counts what we spent, so a receipt stuck in `pending` says how
 *    long the hub has been failing to answer it.
 *
 * The report is the run's own log, gzipped beside the receipt. A log whose gzip
 * would be bigger than the agreed cap goes as NO data and an admission
 * (`{ omitted: 'over_cap', bytes }`), which is what the hub expects and what
 * makes it store the receipt without a report rather than truncate a log a
 * reader would take for the whole thing. No log path, or a log that is not
 * there, means no `report` key at all — not an empty one.
 *
 * The publication state is written back onto the receipt object itself, on the
 * item, in the array it came from — `item.verificationReceipts` for a run's
 * receipt, `item.reviewReceipts` for a review's. Nothing else about the receipt
 * is changed, and the state never leaves this machine: it is stripped before the
 * body is sent, so the hub's stored receipt is the receipt the close path
 * wrote.
 */
import * as fs from 'fs';
import * as os from 'os';
import { redactLog } from './redact.js';
import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import type { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { HubConfig } from './types.js';
import type { FetchLike } from './flowSync.js';

/**
 * Largest UNCOMPRESSED log we will put on the wire. Matches the hub's own cap
 * (`receiptReportMaxBytes` / `DEFAULT_REPORT_MAX_BYTES`), which it measures on
 * the inflated report — so the two sides measure the same thing and a log the
 * client was willing to send is a log the hub is willing to keep.
 */
const DEFAULT_MAX_REPORT_BYTES = 32 * 1024 * 1024;

/**
 * Largest GZIP we will put on the wire. A separate, smaller limit: the body is
 * base64, which grows a third, and the hub refuses a JSON body past 10 MB — so
 * 7 MB of gzip keeps the encoded body near 9.3 MB and the receipt arrives.
 */
const DEFAULT_MAX_REPORT_GZ_BYTES = 7 * 1024 * 1024;

/** How a receipt's publication to the hub stands right now. */
export interface ReceiptPublication {
  state: 'pending' | 'acked' | 'rejected';
  /** Sends we have spent on it, this one included. */
  attempts: number;
  /** Why it is not acked yet (or why the hub refused it); null when acked. */
  lastError: string | null;
  /** When the hub acknowledged it, ISO. Null until it did. */
  ackedAt: string | null;
  /** The hub's own verdict, echoed back so the card says what the hub decided. */
  reusable?: boolean;
  /** Why the hub said it is not reusable, or null when it is. */
  reason?: string | null;
}

export interface PublishPendingReceiptsArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  fetchImpl: FetchLike;
  /**
   * Largest uncompressed log we will put on the wire. Bigger and we send
   * `{ omitted: 'over_cap', bytes }` — the hub's cap, not ours, and the same
   * number the hub applies to the inflated report it receives.
   */
  maxReportBytes?: number;
  /**
   * Largest gzip we will put on the wire. Bigger and we send
   * `{ omitted: 'over_cap', bytes }` — the limit that keeps the base64 body
   * under the hub's JSON body limit, not the log cap above.
   */
  maxReportGzBytes?: number;
  /**
   * How long one receipt's request may take, headers AND body. Passes run one
   * after another, so a hub that stalls mid-answer would otherwise hold every
   * later publish behind it; past the deadline the receipt stays pending.
   */
  timeoutMs?: number;
}

/** Default deadline for one receipt's request, headers and body. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

export interface PublishReceiptsResult {
  acked: number;
  rejected: number;
  pending: number;
}

/**
 * A card's claim on another machine, plus our delivery state on it: a
 * verification receipt as the close path wrote it (task f918a42c) or a review
 * receipt as the record path writes it (task 95ba0ec5).
 */
interface StoredReceipt {
  id?: unknown;
  kind?: unknown;
  version?: unknown;
  execution?: { logPath?: unknown } | null;
  publication?: ReceiptPublication;
  [key: string]: unknown;
}

/** What the hub answered for one receipt. */
type HubAnswer =
  | { kind: 'acked'; reusable: boolean; reason: string | null }
  | { kind: 'rejected'; status: number; code: string | null; error: string | null }
  | { kind: 'pending'; error: string };

/** The code is what a human acts on; a hub that sends none still names itself. */
const codeOf = (body: any): string | null =>
  typeof body?.code === 'string' && body.code ? body.code : null;

/**
 * One receipt's report, or no `report` key.
 *
 * Read lazily and tolerantly: a log path that is not a file, is not readable,
 * or is a directory is simply a receipt with no report. The receipt is the
 * claim; a missing log makes it weaker, it does not make it false, and the run
 * it describes really happened.
 *
 * Two caps, and either one omits the report: the log's own size against the
 * hub's cap on what it will hold, and the gzip's size against the limit that
 * keeps the encoded body under the hub's request limit. The first is checked
 * before compressing, since a log we are not going to send is not worth
 * gzipping.
 */
function reportOf(
  logPath: unknown,
  maxReportBytes: number,
  maxReportGzBytes: number,
): Record<string, unknown> | undefined {
  if (typeof logPath !== 'string' || !logPath) return undefined;
  // The size first: a multi-gigabyte log refused on its size is never read into
  // this process, which serves every other request while it reads.
  let size: number;
  try {
    const st = fs.statSync(logPath);
    if (!st.isFile()) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }
  if (size > maxReportBytes) return { omitted: 'over_cap', bytes: size };
  let plain: Buffer;
  try {
    plain = fs.readFileSync(logPath);
  } catch {
    return undefined;
  }
  // The log may have grown between the stat and the read.
  if (plain.length > maxReportBytes) {
    return { omitted: 'over_cap', bytes: plain.length };
  }
  // Redacted before it leaves the machine (RFC-002): what the suite printed
  // goes to the hub and to CI, its secrets and this user's home path do not.
  // The file on disk is left as it is - it is this machine's own record.
  // A redaction that fails sends NO log, never the unredacted one; the receipt
  // still goes, and CI reads "report unavailable" and runs the step.
  let redacted: ReturnType<typeof redactLog>;
  try {
    redacted = redactLog(plain.toString('utf8'), { home: os.homedir(), env: process.env });
  } catch (e) {
    console.error(`[HUB_RECEIPTS] could not redact ${logPath}; sending the receipt without its log: ${(e as Error).message}`);
    return undefined;
  }
  plain = Buffer.from(redacted.text, 'utf8');
  if (plain.length > maxReportBytes) {
    // Say so, with the size, and send nothing — and do not spend a gzip on a
    // log already refused on its plain size.
    return { omitted: 'over_cap', bytes: plain.length };
  }
  const gz = zlib.gzipSync(plain);
  if (gz.length > maxReportGzBytes) {
    // Same admission for a log that is within the cap but incompressible.
    // Truncating would be worse: a reader cannot tell a cut log from the whole
    // run.
    return { omitted: 'over_cap', bytes: plain.length };
  }
  return { encoding: 'gzip+base64', data: gz.toString('base64'), bytes: plain.length, redactions: redacted.count };
}

/**
 * Ask the hub to store one receipt, and read its answer as one of the three
 * states. Every failure path returns an answer rather than throwing: one hub
 * that is down must leave the other receipts on this card trying, and the
 * caller must still write back what happened to each.
 */
async function publishOne(
  receipt: StoredReceipt,
  args: PublishPendingReceiptsArgs,
  maxReportBytes: number,
  maxReportGzBytes: number,
): Promise<HubAnswer> {
  const base = args.hubConfig.url.replace(/\/$/, '');
  // The delivery state is ours and never leaves the machine: the hub stores the
  // receipt exactly as the close path wrote it.
  const { publication: _publication, ...rest } = receipt;
  // The log's path on THIS machine is not sent: it is no use to anyone else and
  // names this user's home. The card keeps it; it is how we find our own log.
  const asSent = rest.execution && typeof rest.execution === 'object'
    ? { ...rest, execution: { ...rest.execution, logPath: null } }
    : rest;
  const report = reportOf(receipt.execution?.logPath, maxReportBytes, maxReportGzBytes);
  const body: Record<string, unknown> = { receipt: asSent };
  if (report) body.report = report;

  // One deadline over the request and the whole answer. The race releases the
  // pass even when a fetch implementation ignores the abort signal.
  const timeoutMs = args.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve('timeout'); }, timeoutMs);
  });
  const exchange = async (): Promise<{ res: Awaited<ReturnType<FetchLike>>; body: any } | { error: string }> => {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await args.fetchImpl(`${base}/v1/receipts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.hubConfig.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      return { error: (e as Error).message || 'network error' };
    }
    // A 2xx is only an acknowledgement if the body names the receipt back. A hub
    // that answered "200" with nothing in it has told us nothing, and a receipt
    // recorded as delivered on the strength of it is a receipt that goes missing.
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { res, body: parsed };
  };
  let outcome: Awaited<ReturnType<typeof exchange>> | 'timeout';
  try {
    outcome = await Promise.race([exchange(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome === 'timeout') return { kind: 'pending', error: `the hub did not answer within ${timeoutMs} ms` };
  if ('error' in outcome) return { kind: 'pending', error: outcome.error };
  const { res, body: body_ } = outcome;

  if (res.status >= 200 && res.status < 300) {
    if (typeof body_?.id !== 'string' || !body_.id) {
      return { kind: 'pending', error: `Hub acknowledged ${res.status} without naming a receipt` };
    }
    // An answer naming ANOTHER receipt acknowledged nothing we sent.
    if (body_.id !== receipt.id) {
      return { kind: 'pending', error: `Hub acknowledged ${res.status} naming a different receipt` };
    }
    return {
      kind: 'acked',
      reusable: body_.reusable === true,
      reason: typeof body_.reason === 'string' ? body_.reason : null,
    };
  }

  // Any other 4xx the hub chose to answer with is a refusal of THIS receipt:
  // the id belongs to someone else, the repo is unknown to the org, the body is
  // malformed. None of that changes because we ask again, so it is final.
  if (res.status >= 400 && res.status < 500) {
    return { kind: 'rejected', status: res.status, code: codeOf(body_), error: typeof body_?.error === 'string' ? body_?.error : null };
  }

  return { kind: 'pending', error: `HTTP ${res.status}` };
}

/** The card's own words about a receipt the hub will not take. */
function refusalComment(receiptId: string, answer: Extract<HubAnswer, { kind: 'rejected' }>): any {
  const code = answer.code ?? 'error';
  return {
    id: randomUUID(),
    author: 'ValidateTool',
    content: `The hub refused verification receipt \`${receiptId}\`: ${answer.status} ${code}. It will not be sent again.`,
    timestamp: new Date(),
  };
}

/**
 * Publish every receipt that is not settled, on every card.
 *
 * The state is written back per CARD and per array, not per receipt: the
 * receipts of one kind share one array, and one write per array means a pass
 * that publishes three receipts across two cards writes each card once. Each
 * write re-reads the card first, because the network is in the gap between
 * reading the receipts and writing their state back — and a card that gained a
 * comment, a test result, or a second receipt while we were waiting on the hub
 * must not lose it. Only the `publication` of each receipt we touched is carried
 * over; everything else on the freshly-read card stands.
 */
/**
 * The pass in flight, if any. The close path and the polling tick both publish,
 * and two overlapping passes would each write back what their own requests
 * heard — an older 500 landing after a newer ack would undo the ack. So passes
 * run one after another in this process: the next starts from the card the
 * previous one wrote.
 */
let passInFlight: Promise<unknown> = Promise.resolve();

export function publishPendingReceipts(args: PublishPendingReceiptsArgs): Promise<PublishReceiptsResult> {
  const pass = passInFlight.catch(() => undefined).then(() => publishPass(args));
  passInFlight = pass;
  return pass;
}

async function publishPass(args: PublishPendingReceiptsArgs): Promise<PublishReceiptsResult> {
  const maxReportBytes = args.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  const maxReportGzBytes = args.maxReportGzBytes ?? DEFAULT_MAX_REPORT_GZ_BYTES;
  const result: PublishReceiptsResult = { acked: 0, rejected: 0, pending: 0 };
  const items = await args.storage.listItems({});

  // Both arrays a card can carry a receipt in: what a run certified and what a
  // review judged are different claims, but they are sent and remembered the
  // same way, each back into the array it came from. A review receipt has no
  // `execution.logPath`, so `reportOf` is handed nothing and it goes with no
  // report — which is what a claim about a review is.
  for (const item of items) {
    for (const array of ['verificationReceipts', 'reviewReceipts'] as const) {
      const receipts = (item as any)[array];
      await publishArray(item, array, receipts);
    }
  }

  return result;

  async function publishArray(
    item: any,
    array: 'verificationReceipts' | 'reviewReceipts',
    receipts: unknown,
  ): Promise<void> {
    if (!Array.isArray(receipts) || receipts.length === 0) return;
    const pending = (receipts as StoredReceipt[]).filter(
      (r) => r && (!r.publication || r.publication.state === 'pending'),
    );
    if (pending.length === 0) return;

    const comments: any[] = [];
    // Receipt id -> the state to write back, kept apart from the write so a
    // card read inside the loop is never the one we are about to overwrite.
    const updates = new Map<string, ReceiptPublication>();
    for (const receipt of pending) {
      const id = typeof receipt.id === 'string' ? receipt.id : '';
      const attempts = (receipt.publication?.attempts ?? 0) + 1;
      const answer = await publishOne(receipt, args, maxReportBytes, maxReportGzBytes);
      if (answer.kind === 'acked') {
        result.acked += 1;
        updates.set(id, {
          state: 'acked', attempts, lastError: null, ackedAt: new Date().toISOString(),
          reusable: answer.reusable, reason: answer.reason,
        });
      } else if (answer.kind === 'rejected') {
        result.rejected += 1;
        const code = answer.code ?? 'error';
        updates.set(id, {
          state: 'rejected', attempts,
          lastError: `${answer.status} ${code}${answer.error ? `: ${answer.error}` : ''}`,
          ackedAt: null,
        });
        comments.push(refusalComment(id || '(no id)', answer));
      } else {
        result.pending += 1;
        updates.set(id, { state: 'pending', attempts, lastError: answer.error, ackedAt: null });
      }
    }

    try {
      const current = await args.storage.getItem(item.id);
      if (!current) return; // closed or deleted while we were talking; nothing to remember it for
      const cur: any = current;
      const currentReceipts: any[] = Array.isArray(cur[array]) ? cur[array] : [];
      // A settled receipt stays settled: whatever wrote `acked` or `rejected`
      // meanwhile heard the hub more recently than a `pending` we hold.
      const settled = (r: any) => r?.publication?.state === 'acked' || r?.publication?.state === 'rejected';
      const merged = currentReceipts.map((r: any) =>
        r && updates.has(r.id) && !settled(r) ? { ...r, publication: updates.get(r.id) } : r,
      );
      const write: Record<string, unknown> = { [array]: merged };
      if (comments.length) {
        // One comment per refusal, on the card that carries the receipt: a
        // receipt the hub will not take is a gap in the record that nobody
        // would otherwise ever see.
        write.comments = [...((cur.comments as any[]) ?? []), ...comments];
      }
      await args.storage.updateItem(item.id, write as any);
    } catch (e) {
      // The receipts stay unpublished and will be tried again; the hub having
      // them without our card knowing is a smaller lie than the reverse.
      console.error(`[HUB_RECEIPTS] could not record publication on ${item.id}: ${(e as Error).message}`);
    }
  }
}
