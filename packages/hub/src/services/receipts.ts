import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { HubDb } from '../db/types.js';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';
import { producerCheckOf } from './repoSettings.js';

/**
 * Receipt storage (RFC-002, task 0334a5e6).
 *
 * A receipt is a claim one machine makes for another to honour — "this
 * command, run on this tree, passed on this card" — and the hub is the place
 * such a claim becomes a record. Three properties make the record worth
 * anything, and all three live here rather than in the route:
 *
 *  - **Write-once, idempotent by the receipt's own id.** The id is minted by
 *    the producer, so the same body arriving twice is one row and a retry
 *    (200 `duplicate`), while a *different* body under a taken id is a conflict
 *    (409) and the original row does not move. A client may retry forever
 *    without being able to rewrite a claim it already made, or someone else's.
 *
 *  - **The producer is the credential, never the body.** `installationId` is
 *    the publishing key's installation, passed in by the route. The body's own
 *    idea of who published it is not read at all.
 *
 *  - **The hub decides reusability at write time**, from its own producer
 *    allowlist and its own report cap, and records which of them said no.
 *    A producer cannot make its own receipt reusable, and one that declines to
 *    offer it is heard.
 *
 * The repository is the canonical URL (`canonicalRepo`), so a receipt naming
 * `https://github.com/acme/app.git` lands on the record an installation claimed
 * with `git@github.com:acme/app.git`. A repository the org has never claimed
 * gets no receipt at all: the store cannot be filled with claims about repos
 * nobody verifies.
 *
 * Every query filters by `org_id`, and the org comes from the caller's
 * credential at the route. The 409 says nothing about the row that caused it —
 * which may belong to another org, and whose it is not an oracle to hand out.
 */

/** Every report the hub has ever been asked to keep is gzipped under this name. */
export const REPORT_ENCODING = 'gzip+base64';

/**
 * Default cap on the UNCOMPRESSED report the hub keeps (32 MiB).
 *
 * The cap is measured on the log, not on the gzip that carries it (see
 * `decodeReport`), so it is a cap on what the hub agrees to hold and hand to a
 * reader, not on how compressible the log happened to be. The client applies
 * the same number to the plain log before it sends, and separately keeps the
 * gzip itself small enough that the base64 body stays under the hub's JSON body
 * limit — the two limits protect different things and both are on the client.
 */
export const DEFAULT_REPORT_MAX_BYTES = 32 * 1024 * 1024;

/** A receipt id is minted by the client and is the row's primary key. Bounded. */
export const MAX_RECEIPT_ID_LENGTH = 64;

/** What a receipt id may be made of: what a uuid or a short dotted name holds. */
const RECEIPT_ID_CHARS = /^[A-Za-z0-9._:-]+$/;

/**
 * A git remote names a host. `sanitizeRemoteUrl` is a CANONICISER, not a
 * validator: whatever does not parse it comes back lower-cased and stripped,
 * and "not a repo" stripped is still "notarepo". Fine for a chip label, not
 * for a receipt — so this is the shape the canonicaliser PRODUCES for a real
 * remote, which `canonicalRepo` alone cannot tell from a stripped phrase.
 */
const CANONICAL_REMOTE_RE = /^[^/\s@]+@[^/\s:]+:[^/\s]+\/[^/\s]+\.git$/;

/** A bare `owner/repo` slug: no host, and github.com is where AgEnFK PRs open. */
const REPO_SLUG_RE = /^[^/\s]+\/[^/\s]+(?:\.git)?$/;

/**
 * A usable remote, in the hub's canonical spelling.
 *
 * A phrase ("not a repo") and a path on the producer's own disk ("./clone",
 * "/srv/git/app") are both refused rather than canonicalised: no hub record can
 * ever match either, and filing a machine's local checkout among the remotes a
 * receipt is supposed to be trusted with is worse than refusing it. A bare
 * `owner/repo` slug is the exception the event ingestion already makes.
 */
function receiptRepo(input: unknown): string {
  if (typeof input !== 'string') throw new ReceiptError('invalid_receipt', 'receipt.repo must be a string');
  const trimmed = input.trim();
  if (!trimmed) throw new ReceiptError('invalid_receipt', 'receipt.repo is required');
  const canonical = sanitizeRemoteUrl(trimmed);
  if (!CANONICAL_REMOTE_RE.test(canonical) && !REPO_SLUG_RE.test(canonical)) {
    throw new ReceiptError('invalid_receipt', 'receipt.repo is not a usable git remote');
  }
  return canonical;
}

/** The kinds this hub issues records for. A review receipt arrives later. */
export const RECEIPT_KINDS = ['verification', 'review'] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/** Why a request could not be served, mapped to a status by the route. */
export class ReceiptError extends Error {
  constructor(
    readonly code: 'invalid_receipt' | 'invalid_report' | 'repo_unknown' | 'receipt_conflict',
    message: string,
  ) {
    super(message);
  }
}

/** Why the hub will not let this receipt be reused, in the order the tests read. */
export type NotReusableReason = 'producer_not_allowed' | 'report_over_cap' | 'not_reusable_by_producer';

/** What the client sent for the report: gzip under this base64, or an admission. */
export type ReportInput =
  | { encoding: string; data: string; bytes?: unknown }
  | { omitted: 'over_cap'; bytes?: unknown };

export interface StoreReceiptArgs {
  /** The receipt exactly as received. Stored verbatim, hashed as stored. */
  receipt: Record<string, unknown>;
  /** How to treat the run's log, or null/undefined when the client sent none. */
  report?: ReportInput | null;
  /** Cap on the GZIPPED bytes kept. Over it: no report, and not reusable. */
  capBytes: number;
}

export interface StoredReceipt {
  id: string;
  /** 'new' for the insert that made the row, 'duplicate' for a retry of it. */
  stored: 'new' | 'duplicate';
  reusable: boolean;
  reason: NotReusableReason | null;
}

/** The row, as the columns name them. */
interface ReceiptRow {
  id: string;
  org_id: string;
  remote_url: string;
  kind: string;
  installation_id: string;
  card_id: string | null;
  content_tree: string | null;
  command_revision: unknown;
  body_json: string;
  body_hash: string;
  reusable: unknown;
  not_reusable_reason: string | null;
  report_gz_b64: string | null;
  report_bytes: unknown;
  received_at: string;
}

const nowIso = () => new Date().toISOString();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A string we can act on, or null. Trimming only ever makes a value shorter. */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** A whole number we can act on, or null (never 0 for "absent"). */
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * The receipt's id: non-empty, bounded, and stored exactly as sent.
 *
 * Bounded because it is a primary key the client writes — an unbounded id is a
 * row of arbitrary size pushed by a caller that likes big strings. Stored
 * untrimmed because `body_hash` is a hash of the body as received, and a route
 * that stored a trimmed id while hashing the untrimmed body would be comparing
 * two different receipts on the next retry.
 */
function validId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new ReceiptError('invalid_receipt', 'receipt.id is required');
  if (input.length > MAX_RECEIPT_ID_LENGTH) {
    throw new ReceiptError('invalid_receipt', `receipt.id is longer than ${MAX_RECEIPT_ID_LENGTH} characters`);
  }
  // The id travels into CI: GITHUB_OUTPUT lines, step summaries, file names. A
  // newline in it could forge another output line (`run=false`), so ids are
  // the characters clients actually mint and nothing else (Codex review).
  if (!RECEIPT_ID_CHARS.test(input)) {
    throw new ReceiptError('invalid_receipt', 'receipt.id may hold only letters, digits and . _ : -');
  }
  return input;
}

/**
 * The report, as three answers the store needs and nothing else: the gzip to
 * keep (or nothing, if the log behind it is over the cap), the size to record,
 * and whether the report is simply too big to be kept.
 *
 * `data` must decode from base64 AND inflate as gzip. Both are checked here, on
 * the producer's word, because the alternative is storing a blob under a name
 * that promises it inflates: a reader would find the promise broken at the worst
 * possible moment, which is while deciding whether to trust a run it cannot
 * reproduce.
 */
function decodeReport(
  report: ReportInput | null | undefined,
  capBytes: number,
): { gzB64: string | null; bytes: number | null; overCap: boolean; tooBig: boolean } {
  // No report at all: nothing to keep, nothing over a cap, and no size to name.
  if (report === null || report === undefined) return { gzB64: null, bytes: null, overCap: false, tooBig: false };
  if (typeof report !== 'object') throw new ReceiptError('invalid_report', 'report must be an object');

  // The producer's own admission that the log is too big to send. The size it
  // names is still worth recording — "too big" is more useful with a number.
  if ((report as { omitted?: unknown }).omitted === 'over_cap') {
    return { gzB64: null, bytes: intOrNull((report as { bytes?: unknown }).bytes), overCap: true, tooBig: true };
  }

  const { encoding, data } = report as { encoding?: unknown; data?: unknown };
  if (encoding !== REPORT_ENCODING) {
    throw new ReceiptError('invalid_report', `report.encoding must be '${REPORT_ENCODING}'`);
  }
  if (typeof data !== 'string' || !data) throw new ReceiptError('invalid_report', 'report.data must be base64 of a gzip stream');

  let gz: Buffer;
  try {
    gz = Buffer.from(data, 'base64');
  } catch {
    throw new ReceiptError('invalid_report', 'report.data is not valid base64');
  }
  if (gz.length === 0) throw new ReceiptError('invalid_report', 'report.data is not base64 of a gzip stream');
  // The cap is measured on the LOG, inflated, not on the gzip that carries it:
  // the thing the hub is protecting itself against is the size of the run log
  // it agrees to hold and to hand to a reader, and a gzip's size is a fact about
  // how compressible the log happened to be — forty kilobytes of one repeated
  // character inflates to nothing to compress and to a whole log to read. The
  // inflate also happens whatever the size, since a report whose gzip is tiny
  // can still unroll enormous (`zlib` refuses past `maxOutputLength`), so an
  // honest producer is never punished for being honest about its size.
  let plain: Buffer;
  try {
    plain = zlib.gunzipSync(gz, { maxOutputLength: capBytes });
  } catch (e) {
    if (isTooBig(e)) return { gzB64: null, bytes: intOrNull((report as { bytes?: unknown }).bytes), overCap: true, tooBig: true };
    throw new ReceiptError('invalid_report', 'report.data is not a gzip stream');
  }
  return {
    gzB64: data,
    // The size the producer declared, when it declared one — `report_bytes` is
    // the log's size as its author saw it, and a client that named none is not
    // owed a number we invented.
    bytes: intOrNull((report as { bytes?: unknown }).bytes) ?? plain.length,
    overCap: false,
    tooBig: false,
  };
}

/**
 * Did zlib refuse because the log is bigger than the cap, rather than because
 * it is not a gzip at all? The first is a decision (store the receipt without
 * its report); the second is a bad request (store nothing). Both arrive as an
 * error from the same call, and only the first says the bytes are fine.
 */
function isTooBig(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ERR_BUFFER_TOO_LARGE'
    || /maximum[^\n]*length|buffer too large/i.test(String((e as Error | null)?.message ?? ''));
}

/**
 * Is this receipt reusable? Decided here, at write time, in this order — the
 * first reason that applies is the one recorded, because a receipt stored with
 * three reasons is a receipt a reader cannot act on.
 *
 * `reportOverCap` covers both ways the report can be too big: the producer
 * gave up on it, or the gzip it sent is bigger than this hub's cap.
 */
function decideReusability(opts: {
  producerAllowed: boolean;
  reportOverCap: boolean;
  offeredReusable: boolean;
}): { reusable: boolean; reason: NotReusableReason | null } {
  if (!opts.producerAllowed) return { reusable: false, reason: 'producer_not_allowed' };
  if (opts.reportOverCap) return { reusable: false, reason: 'report_over_cap' };
  if (!opts.offeredReusable) return { reusable: false, reason: 'not_reusable_by_producer' };
  return { reusable: true, reason: null };
}

/**
 * Store one receipt, once.
 *
 * ONE transaction, because the insert and the decision about a clash must not
 * have a gap in the middle: `INSERT OR IGNORE` (which the dialect translator
 * turns into `ON CONFLICT DO NOTHING` for PG, with `changes` the row count
 * either way) settles whether the row is ours, and only when it is not do we
 * read the standing row and compare bodies. Two callers pushing the same
 * receipt at the same moment therefore both end up with one row, one of them
 * told 'new' and the other 'duplicate'.
 *
 * The repository's settings row is read inside the same transaction: it is the
 * allowlist the reusability decision is made against, and reading it outside
 * would let an admin's removal land between the read and the write.
 */
export async function storeReceipt(
  db: HubDb,
  orgId: string,
  installationId: string,
  body: unknown,
  capBytes: number,
): Promise<StoredReceipt> {
  if (!body || typeof body !== 'object') throw new ReceiptError('invalid_receipt', 'receipt is required');
  const receipt = (body as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ReceiptError('invalid_receipt', 'receipt is required');
  }
  const rcpt = receipt as Record<string, unknown>;

  // A repo that is not a usable remote is a bad RECEIPT, whatever the repo
  // helper's own code calls it: the caller asked to store a receipt, and the
  // receipt is what is malformed. Translated rather than passed through, so the
  // answer is `invalid_receipt` and not a repo-settings code on a receipt route.
  const remoteUrl = receiptRepo(rcpt.repo);

  const id = validId(rcpt.id);
  const kind = str(rcpt.kind);
  if (kind === null || !(RECEIPT_KINDS as readonly string[]).includes(kind)) {
    throw new ReceiptError('invalid_receipt', `receipt.kind must be one of ${RECEIPT_KINDS.join(', ')}`);
  }
  if (rcpt.version !== 1) throw new ReceiptError('invalid_receipt', 'receipt.version must be 1');
  // A review CI may stand in for has to say what it covered and what it found:
  // a receipt with no findings list would let a step skip on a review whose
  // outcome nobody can read (Codex review). An empty list is a clean review.
  if (kind === 'review') {
    const review = rcpt.review as { findings?: unknown; lenses?: unknown } | undefined;
    if (!review || typeof review !== 'object') throw new ReceiptError('invalid_receipt', 'a review receipt needs receipt.review');
    if (!Array.isArray(review.findings)) throw new ReceiptError('invalid_receipt', 'receipt.review.findings must be a list');
    if (!Array.isArray(review.lenses) || review.lenses.length === 0 || !review.lenses.every(l => typeof l === 'string' && l)) {
      throw new ReceiptError('invalid_receipt', 'receipt.review.lenses must name at least one lens');
    }
  }

  // The report is validated before anything is written: a request whose log is
  // not a log wrote no receipt, rather than a receipt with a broken attachment.
  const report = decodeReport((body as { report?: ReportInput | null }).report, capBytes);

  // `JSON.stringify` once and keep the string: the stored text, the hashed
  // text, and the text a retry is compared against are then the same bytes,
  // which is the only way `body_hash` can mean "the same receipt".
  const bodyJson = JSON.stringify(rcpt);
  const bodyHash = sha256(bodyJson);
  const cardId = str((rcpt.card as { id?: unknown } | undefined)?.id);
  const content = rcpt.content as { gitTree?: unknown } | undefined;
  const contentTree = str(content?.gitTree);
  const execution = rcpt.execution as { commandRevision?: unknown } | undefined;
  const commandRevision = intOrNull(execution?.commandRevision);
  const at = nowIso();

  return await db.transaction(async (): Promise<StoredReceipt> => {
    // The repo must be one this org claims: its settings row is also the
    // producer allowlist the decision below is made against.
    const settings = await db.get<{ remote_url: string }>(
      'SELECT remote_url FROM repo_settings WHERE org_id = ? AND remote_url = ?',
      [orgId, remoteUrl],
    );
    if (!settings) throw new ReceiptError('repo_unknown', 'this repository has no settings for this organisation');

    const inserted = await db.run(
      `INSERT OR IGNORE INTO receipts
         (id, org_id, remote_url, kind, installation_id, card_id, content_tree, command_revision,
          body_json, body_hash, reusable, not_reusable_reason, report_gz_b64, report_bytes, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      [
        id, orgId, remoteUrl, kind, installationId, cardId, contentTree, commandRevision,
        bodyJson, bodyHash,
        // Over the cap the bytes are not kept at all — see the column comment.
        report.overCap || report.tooBig ? null : report.gzB64,
        // The size the PRODUCER declared, never the size we happened to keep:
        // a report dropped for being big still says how big it was.
        report.bytes,
        at,
      ],
    );

    if (inserted.changes === 1) {
      // OUR row. The repository's producer rule as it stands inside the lock:
      // its allowlist, or under 'all' whether this installation is a live one
      // of the org (RFC-002 Amendment 1).
      const producerAllowed = (await producerCheckOf(db, orgId, remoteUrl, [installationId]))(installationId);
      const overCap = report.overCap || report.tooBig;
      const decision = decideReusability({
        producerAllowed,
        reportOverCap: overCap,
        offeredReusable: rcpt.reusable === true,
      });
      await db.run('UPDATE receipts SET reusable = ?, not_reusable_reason = ? WHERE id = ?', [
        decision.reusable ? 1 : 0, decision.reason, id,
      ]);
      return { id, stored: 'new', ...decision };
    }

    // Not ours. It is a duplicate only of OUR OWN receipt: another org's row,
    // or any row under a different body, is a conflict — and the answer says
    // nothing about which row it collided with, because whose it is would be
    // information the caller has no right to.
    const existing = await db.get<ReceiptRow>(
      'SELECT org_id, body_hash FROM receipts WHERE id = ?',
      [id],
    );
    if (existing && String(existing.org_id) === orgId && String(existing.body_hash) === bodyHash) {
      const standing = await db.get<{ reusable: unknown; not_reusable_reason: string | null }>(
        'SELECT reusable, not_reusable_reason FROM receipts WHERE id = ?',
        [id],
      );
      const reusable = Number(standing?.reusable ?? 0) === 1;
      return {
        id,
        stored: 'duplicate',
        reusable,
        reason: reusable ? null : (standing?.not_reusable_reason as NotReusableReason | null) ?? null,
      };
    }
    throw new ReceiptError('receipt_conflict', 'that receipt id already holds a different receipt');
  });
}

/** Map a service error to the status the route answers with. */
export const STATUS_FOR_RECEIPT_ERROR: Record<ReceiptError['code'] | 'receipt_conflict', number> = {
  invalid_receipt: 400,
  invalid_report: 400,
  repo_unknown: 404,
  receipt_conflict: 409,
};

