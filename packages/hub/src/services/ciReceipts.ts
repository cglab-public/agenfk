import * as zlib from 'node:zlib';
import type { HubDb } from '../db/types.js';
import { generateCiToken } from '../auth/ciToken.js';
import { hashToken } from '../auth/apiKey.js';
import type { CiTokenContext } from '../auth/ciToken.js';
import { canonicalRepo, producerCheckOf, RepoSettingsError, type ProducerCheck } from './repoSettings.js';
import { RECEIPT_KINDS, type ReceiptKind } from './receipts.js';

/**
 * CI's side of the receipts (RFC-002, task 0e0a3cd4): the `ci_` tokens an
 * admin mints, and the reads a CI job makes with one.
 *
 * Everything here is a READ of what installations published, scoped twice:
 * by the token's org on every query, and by the token's repository when it
 * has one. A receipt outside either scope answers exactly like a receipt that
 * does not exist, so the API is no oracle for another org's ids.
 *
 * The lookup only finds candidates. Whether one of them may stand in for a CI
 * step — same tree as CI's own checkout, current command revision, the lens
 * the step needs — is the CI side's decision, so each candidate carries the
 * facts that decision reads and nothing is filtered on its behalf beyond the
 * kind and lens it asked for.
 */

export class CiError extends Error {
  constructor(
    readonly code:
      | 'invalid_repo' | 'repo_required' | 'invalid_scope' | 'invalid_label' | 'repo_unknown'
      | 'invalid_kind' | 'invalid_pr' | 'invalid_tree' | 'invalid_lens' | 'lookup_required'
      | 'repo_out_of_scope' | 'receipt_not_found' | 'report_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export const STATUS_FOR_CI_ERROR: Record<CiError['code'], number> = {
  invalid_repo: 400,
  repo_required: 400,
  invalid_scope: 400,
  invalid_label: 400,
  invalid_kind: 400,
  invalid_pr: 400,
  invalid_tree: 400,
  invalid_lens: 400,
  lookup_required: 400,
  repo_unknown: 404,
  repo_out_of_scope: 403,
  receipt_not_found: 404,
  report_unavailable: 404,
};

const MAX_LABEL_LENGTH = 100;
/** How many candidates one lookup returns. CI reads the newest; the rest are context. */
const MAX_CANDIDATES = 50;
/**
 * How many rows one lookup reads, before the lens filter. Bounded in SQL so a
 * card or tree with thousands of receipts costs the same as one with fifty.
 */
const MAX_SCANNED = 200;
/** Same rule the server applies when a review is recorded with lenses. */
const LENS_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A git tree id: sha1 (40 hex) or sha256 (64 hex). */
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const nowIso = () => new Date().toISOString();

const intOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** The repo as the hub spells it, or `invalid_repo` under this service's own error. */
function repoOf(input: unknown): string {
  try {
    return canonicalRepo(input);
  } catch (e) {
    if (e instanceof RepoSettingsError) throw new CiError('invalid_repo', e.message);
    throw e;
  }
}

async function repoSettingsOf(db: HubDb, orgId: string, remoteUrl: string) {
  return db.get<{ verify_command: string; revision: unknown; receipts_mode: string }>(
    'SELECT verify_command, revision, receipts_mode FROM repo_settings WHERE org_id = ? AND remote_url = ?',
    [orgId, remoteUrl],
  );
}

// ── tokens ──────────────────────────────────────────────────────────────────

export interface IssuedCiToken {
  token: string;
  tokenHashPreview: string;
  label: string | null;
  scope: 'repo' | 'org';
  repo: string | null;
}

/**
 * Mint a CI token. One repository is the default and needs `repo`; the whole
 * organisation is `scope: 'org'` and takes no repository, so a forgotten field
 * can never widen a token to every repository the org verifies. The repository
 * must be one this org verifies: a token for a repo nobody verifies could only
 * ever read nothing, and is far more likely a typo.
 */
export async function issueCiToken(
  db: HubDb,
  orgId: string,
  body: { label?: unknown; scope?: unknown; repo?: unknown },
  createdByEmail: string | null,
): Promise<IssuedCiToken> {
  const scope = body.scope === undefined || body.scope === null ? 'repo' : body.scope;
  if (scope !== 'repo' && scope !== 'org') throw new CiError('invalid_scope', "scope must be 'repo' or 'org'");
  const hasRepo = body.repo !== undefined && body.repo !== null;
  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string' || body.label.trim().length > MAX_LABEL_LENGTH) {
      throw new CiError('invalid_label', `label must be a string of at most ${MAX_LABEL_LENGTH} characters`);
    }
    label = body.label.trim() || null;
  }

  let remoteUrl: string | null = null;
  if (scope === 'org') {
    if (hasRepo) throw new CiError('invalid_scope', 'an org-wide token names no repository; drop repo, or drop scope for a repository token');
  } else {
    if (!hasRepo) throw new CiError('repo_required', "a CI token reads one repository: name it in repo, or ask for scope 'org'");
    remoteUrl = repoOf(body.repo);
    if (!(await repoSettingsOf(db, orgId, remoteUrl))) {
      throw new CiError('repo_unknown', 'this repository has no settings for this organisation');
    }
  }

  const token = generateCiToken();
  const tokenHash = hashToken(token);
  await db.run(
    'INSERT INTO ci_tokens (token_hash, org_id, remote_url, label, created_at, created_by_email) VALUES (?, ?, ?, ?, ?, ?)',
    [tokenHash, orgId, remoteUrl, label, nowIso(), createdByEmail],
  );
  return { token, tokenHashPreview: tokenHash.slice(0, 8), label, scope, repo: remoteUrl };
}

export async function listCiTokens(db: HubDb, orgId: string) {
  const rows = await db.all<any>(
    'SELECT token_hash, remote_url, label, created_at, created_by_email, revoked_at FROM ci_tokens WHERE org_id = ? ORDER BY created_at DESC',
    [orgId],
  );
  return rows.map(r => ({
    tokenHashPreview: String(r.token_hash).slice(0, 8),
    label: r.label ?? null,
    scope: r.remote_url ? 'repo' as const : 'org' as const,
    repo: r.remote_url ?? null,
    createdAt: r.created_at,
    createdByEmail: r.created_by_email ?? null,
    revokedAt: r.revoked_at ?? null,
  }));
}

/**
 * Revoke by a prefix of the hash, the way api keys are revoked: hex only (a
 * '%' would be a LIKE wildcard over every token), at least 8 characters, and
 * one live token at most — the caller is asked for more characters rather
 * than told a count that hides a second revocation.
 */
export async function revokeCiToken(
  db: HubDb,
  orgId: string,
  preview: string,
): Promise<{ revoked: number } | { ambiguous: number }> {
  const prefix = preview.toLowerCase();
  const matches = await db.all<{ token_hash: string }>(
    'SELECT token_hash FROM ci_tokens WHERE org_id = ? AND token_hash LIKE ? AND revoked_at IS NULL',
    [orgId, `${prefix}%`],
  );
  if (matches.length > 1) return { ambiguous: matches.length };
  if (matches.length === 0) return { revoked: 0 };
  const result = await db.run(
    'UPDATE ci_tokens SET revoked_at = ? WHERE org_id = ? AND token_hash = ? AND revoked_at IS NULL',
    [nowIso(), orgId, matches[0].token_hash],
  );
  return { revoked: result.changes };
}

// ── reads ───────────────────────────────────────────────────────────────────

interface ReceiptListRow {
  id: string;
  kind: string;
  card_id: string | null;
  content_tree: string | null;
  command_revision: unknown;
  installation_id: string;
  reusable: unknown;
  not_reusable_reason: string | null;
  report_bytes: unknown;
  has_report: unknown;
  body_json: string;
  received_at: string | Date;
}

const RECEIPT_COLUMNS = `id, kind, card_id, content_tree, command_revision, installation_id, reusable,
  not_reusable_reason, report_bytes, CASE WHEN report_gz_b64 IS NULL THEN 0 ELSE 1 END AS has_report,
  body_json, received_at`;

/** What CI needs to judge one candidate, without its body or its report. */
function summaryOf(row: ReceiptListRow, body: any, producerAllowed: ProducerCheck) {
  const available = Number(row.has_report) === 1;
  const reusable = Number(row.reusable) === 1;
  return {
    id: row.id,
    kind: row.kind as ReceiptKind,
    cardId: row.card_id ?? null,
    contentTree: row.content_tree ?? null,
    commit: typeof body?.content?.commit === 'string' ? body.content.commit : null,
    commandRevision: intOrNull(row.command_revision),
    reusable,
    notReusableReason: reusable ? null : row.not_reusable_reason ?? null,
    installationId: row.installation_id,
    // The producer rule as it stands NOW: `reusable` was decided when the
    // receipt was written, and an admin who removed the producer since - or,
    // under 'all', retired the installation - has said its receipts no longer
    // stand in for anything.
    producerAllowed: producerAllowed(row.installation_id),
    // When the evidence was MADE: the run's finish, the review's record. Not
    // when the hub received it - a receipt that waited offline for weeks is
    // weeks old when it arrives, and --max-age asks about the evidence.
    evidenceAt: evidenceAtOf(row.kind, body),
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    ...(row.kind === 'review' ? { lenses: lensesOf(body) } : {}),
    // The declared size even when the report was not kept: "too big" says how big.
    report: { available, bytes: intOrNull(row.report_bytes) },
  };
}

function evidenceAtOf(kind: string, body: any): string | null {
  const at = kind === 'review' ? body?.review?.recordedAt : body?.execution?.finishedAt;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return at;
}

const lensesOf = (body: any): string[] =>
  Array.isArray(body?.review?.lenses) ? body.review.lenses.filter((l: unknown) => typeof l === 'string') : [];

const parseBody = (s: string): any => {
  try { return JSON.parse(s); } catch { return null; }
};

/** The repository a read names, after the token's scope has had its say. */
function scopedRepo(token: CiTokenContext, input: unknown): string {
  if (input === undefined || input === null || input === '') throw new CiError('invalid_repo', 'repo is required');
  const remoteUrl = repoOf(input);
  if (token.remoteUrl && token.remoteUrl !== remoteUrl) {
    throw new CiError('repo_out_of_scope', 'this CI token reads another repository');
  }
  return remoteUrl;
}

export interface LookupQuery {
  repo?: unknown;
  kind?: unknown;
  pr?: unknown;
  tree?: unknown;
  lens?: unknown;
}

const queryString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

/**
 * Candidates for one CI step: by repository + PR number first, through the
 * newest pr.opened / pr.updated event that ties the PR to its root card; by
 * content tree when the PR names no card, or its card has no receipt of this
 * kind. `lookup.by` says which one answered (null: neither found anything).
 */
export async function lookupReceipts(db: HubDb, token: CiTokenContext, q: LookupQuery) {
  const remoteUrl = scopedRepo(token, q.repo);
  const kind = queryString(q.kind);
  if (!kind || !(RECEIPT_KINDS as readonly string[]).includes(kind)) {
    throw new CiError('invalid_kind', `kind must be one of ${RECEIPT_KINDS.join(', ')}`);
  }
  const prText = queryString(q.pr);
  let pr: number | null = null;
  if (prText !== null) {
    if (!/^\d{1,9}$/.test(prText) || Number(prText) < 1) throw new CiError('invalid_pr', 'pr must be a positive whole number');
    pr = Number(prText);
  }
  const treeText = queryString(q.tree);
  let tree: string | null = null;
  if (treeText !== null) {
    tree = treeText.toLowerCase();
    if (!TREE_ID.test(tree)) throw new CiError('invalid_tree', 'tree must be a git tree id (40 or 64 hex characters)');
  }
  const lensText = queryString(q.lens);
  if (lensText !== null && !LENS_NAME.test(lensText)) throw new CiError('invalid_lens', 'lens must be a name like security or general');
  if (pr === null && tree === null) throw new CiError('lookup_required', 'name the pull request (pr) or the content tree (tree) to look up');

  const settings = await repoSettingsOf(db, token.orgId, remoteUrl);
  if (!settings) throw new CiError('repo_unknown', 'this repository has no settings for this organisation');
  const candidates = async (column: 'card_id' | 'content_tree', value: string) => {
    const rows = await db.all<ReceiptListRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts
        WHERE org_id = ? AND remote_url = ? AND kind = ? AND ${column} = ?
        ORDER BY received_at DESC, id DESC
        LIMIT ${MAX_SCANNED}`,
      [token.orgId, remoteUrl, kind, value],
    );
    const kept = rows
      .map(r => ({ row: r, body: parseBody(r.body_json) }))
      .filter(({ body }) => lensText === null || lensesOf(body).includes(lensText))
      .slice(0, MAX_CANDIDATES);
    const producers = await producerCheckOf(db, token.orgId, remoteUrl, kept.map(({ row }) => row.installation_id));
    return kept.map(({ row, body }) => summaryOf(row, body, producers));
  };

  let cardId: string | null = null;
  let by: 'pr' | 'tree' | null = null;
  let receipts: ReturnType<typeof summaryOf>[] = [];
  if (pr !== null) {
    // The payload's number is read as text on both dialects: SQLite's
    // json_extract hands back an INTEGER, Postgres's #>> a TEXT.
    const event = await db.get<{ item_id: string }>(
      `SELECT item_id FROM events
        WHERE org_id = ? AND remote_url = ? AND type IN ('pr.opened', 'pr.updated') AND item_id IS NOT NULL
          AND CAST(json_extract(payload, '$.payload.prNumber') AS TEXT) = ?
        ORDER BY occurred_at DESC, received_at DESC
        LIMIT 1`,
      [token.orgId, remoteUrl, String(pr)],
    );
    cardId = event?.item_id ?? null;
    if (cardId) {
      receipts = await candidates('card_id', cardId);
      if (receipts.length) by = 'pr';
    }
  }
  if (!by && tree !== null) {
    receipts = await candidates('content_tree', tree);
    if (receipts.length) by = 'tree';
  }

  return {
    repo: remoteUrl,
    settings: {
      verifyCommand: settings.verify_command,
      revision: intOrNull(settings.revision),
      receiptsMode: settings.receipts_mode,
    },
    lookup: { by, pr, cardId, tree },
    receipts,
  };
}

/** One receipt row this token may read, or `receipt_not_found` — the same answer for "not yours" and "not there". */
async function readableRow(db: HubDb, token: CiTokenContext, id: string) {
  if (!id || id.length > 64) throw new CiError('receipt_not_found', 'no such receipt');
  const row = await db.get<ReceiptListRow & { remote_url: string; report_gz_b64: string | null }>(
    `SELECT ${RECEIPT_COLUMNS}, remote_url, report_gz_b64 FROM receipts WHERE id = ? AND org_id = ?`,
    [id, token.orgId],
  );
  if (!row || (token.remoteUrl && row.remote_url !== token.remoteUrl)) {
    throw new CiError('receipt_not_found', 'no such receipt');
  }
  return row;
}

export async function getReceipt(db: HubDb, token: CiTokenContext, id: string) {
  const row = await readableRow(db, token, id);
  const body = parseBody(row.body_json);
  const producers = await producerCheckOf(db, token.orgId, row.remote_url, [row.installation_id]);
  return { ...summaryOf(row, body, producers), repo: row.remote_url, receipt: body };
}

/** The run's log as it was written, inflated from the gzip the hub kept. */
export async function getReceiptReport(db: HubDb, token: CiTokenContext, id: string): Promise<Buffer> {
  const row = await readableRow(db, token, id);
  if (!row.report_gz_b64) throw new CiError('report_unavailable', 'this receipt has no report the hub kept');
  return zlib.gunzipSync(Buffer.from(row.report_gz_b64, 'base64'));
}

// ── the admin's view (the Repositories page) ────────────────────────────────

/** How many receipts the Repositories page shows for one repository. */
const ADMIN_RECENT_RECEIPTS = 50;

/**
 * A repository's recent receipts for its admin, newest first: the same summary
 * CI reads, plus the card's title from the snapshot the receipt carries, since
 * the admin is looking for a card and the hub has no other record of it.
 */
export async function listRepoReceipts(db: HubDb, orgId: string, repo: unknown) {
  const remoteUrl = canonicalRepo(repo);
  const rows = await db.all<ReceiptListRow>(
    `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE org_id = ? AND remote_url = ?
      ORDER BY received_at DESC, id DESC LIMIT ${ADMIN_RECENT_RECEIPTS}`,
    [orgId, remoteUrl],
  );
  const producers = await producerCheckOf(db, orgId, remoteUrl, rows.map(r => r.installation_id));
  return rows.map(r => {
    const body = parseBody(r.body_json);
    return { ...summaryOf(r, body, producers), cardTitle: typeof body?.card?.title === 'string' ? body.card.title : null };
  });
}

/** When each of the org's repositories last received a receipt. */
export async function lastReceiptTimes(db: HubDb, orgId: string): Promise<Map<string, string>> {
  const rows = await db.all<{ remote_url: string; last_at: string | Date }>(
    'SELECT remote_url, MAX(received_at) AS last_at FROM receipts WHERE org_id = ? GROUP BY remote_url',
    [orgId],
  );
  return new Map(rows.map(r => [String(r.remote_url), r.last_at instanceof Date ? r.last_at.toISOString() : String(r.last_at)]));
}
