import type { HubDb } from '../db/types.js';
import { machineSpecificPaths } from '@agenfk/core';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';

/**
 * Repository settings (RFC-002).
 *
 * The hub holds ONE authoritative verify command per (org, canonical
 * repository), its revision history, the CI receipts mode and the producer
 * allowlist. Repository identity is the canonical URL from
 * `sanitizeRemoteUrl()` — the same value `events.remote_url` carries — so
 * `git@github.com:acme/app.git` and `https://github.com/acme/app` are one repo
 * here, whatever spelling a caller sends.
 *
 * The command is claimed first-writer-wins: an installation's `init` never
 * overwrites an existing record, so two installations racing on first contact
 * cannot silently disagree about how the repo is verified. Changing it
 * afterwards is an admin act, lands as a new revision, and is audited.
 *
 * Every query filters by `org_id`; the org comes from the caller's credential
 * at the route, never from a body. Timestamps are ISO TEXT written by the app,
 * identical in both dialects.
 */

export const RECEIPTS_MODES = ['off', 'shadow', 'enforce'] as const;
export type ReceiptsMode = (typeof RECEIPTS_MODES)[number];

/**
 * Who may produce a repository's receipts (RFC-002 Amendment 1).
 *
 * - `listed`: only the installations on the repository's `repo_producers`
 *   allowlist - the default, and what every repository meant before the mode
 *   existed.
 * - `all`: any installation of the organisation that is not retired, decided
 *   when it is asked, so a machine that joins later counts and a retired one
 *   stops counting without anyone editing the repository.
 *
 * The allowlist is kept as it is under `all` and applies again when the
 * repository is switched back.
 */
export const PRODUCER_MODES = ['listed', 'all'] as const;
export type ProducerMode = (typeof PRODUCER_MODES)[number];

/** A verify command is a shell line an agent runs. Bounded, never empty. */
export const MAX_VERIFY_COMMAND_LENGTH = 4096;

/** Why a request could not be served, mapped to a status by the route. */
export class RepoSettingsError extends Error {
  constructor(
    readonly code:
      | 'invalid_repo'
      | 'invalid_command'
      | 'machine_specific_path'
      | 'not_found'
      | 'invalid_mode'
      | 'invalid_threshold'
      | 'invalid_producer_mode'
      | 'threshold_required'
      | 'unknown_installation',
    message: string,
  ) {
    super(message);
  }
}

/** The one shape every caller sees of a repo's settings. */
export interface RepoSettingsView {
  remoteUrl: string;
  verifyCommand: string;
  revision: number;
  receiptsMode: ReceiptsMode;
  shadowThreshold: number | null;
  /** Whether the allowlist below or every live installation of the org may produce receipts. */
  producerMode: ProducerMode;
  /**
   * The explicit allowlist, sorted. It decides only under `listed`, and is kept
   * untouched under `all` so switching back restores it.
   */
  producers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoCommandRevision {
  revision: number;
  verifyCommand: string;
  source: 'init' | 'admin';
  actorEmail: string | null;
  installationId: string | null;
  createdAt: string;
}

/** Who revised a command (the signed-in admin). */
export interface RepoCommandActor {
  userId?: string | null;
  email?: string | null;
}

interface SettingsRow {
  remote_url: string;
  verify_command: string;
  revision: unknown;
  receipts_mode: string;
  shadow_threshold: unknown;
  producer_mode: string;
  created_at: string;
  updated_at: string;
}

const nowIso = () => new Date().toISOString();

/** PG hands back integers as strings (and pg-mem as numbers); null stays null. */
const intOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * The repo a request means, in the hub's canonical spelling.
 * Anything that is not a usable string is `invalid_repo` — a caller that
 * invents an identity would otherwise mint a record no clone can ever match.
 */
export function canonicalRepo(input: unknown): string {
  if (typeof input !== 'string') throw new RepoSettingsError('invalid_repo', 'repo must be a string');
  const trimmed = input.trim();
  if (!trimmed) throw new RepoSettingsError('invalid_repo', 'repo is required');
  const canonical = sanitizeRemoteUrl(trimmed);
  if (!canonical) throw new RepoSettingsError('invalid_repo', 'repo is not a usable git remote');
  return canonical;
}

/**
 * A verify command: trimmed, non-empty, bounded, and portable.
 *
 * The hub has nobody's disk, so it cannot tell a repository's own file from
 * Ana's directory next door — but it does not have to. The command it stores
 * runs from the repository root on EVERY machine that clones the repository,
 * so any absolute or home-relative path in it names a file on the one machine
 * that wrote it and nowhere else (the client that CAN see the checkout would
 * have made it `./scripts/verify.sh`). Such a command is refused, whatever the
 * path happens to be on the machine that sent it.
 */
export function validCommand(input: unknown): string {
  if (typeof input !== 'string') throw new RepoSettingsError('invalid_command', 'verifyCommand must be a string');
  const trimmed = input.trim();
  if (!trimmed) throw new RepoSettingsError('invalid_command', 'verifyCommand is required');
  if (trimmed.length > MAX_VERIFY_COMMAND_LENGTH) {
    throw new RepoSettingsError('invalid_command', `verifyCommand is longer than ${MAX_VERIFY_COMMAND_LENGTH} characters`);
  }
  const bad = machineSpecificPaths(trimmed);
  if (bad.length) {
    const listed = bad.map((p) => `\`${p}\``).join(', ');
    throw new RepoSettingsError(
      'machine_specific_path',
      `The verify command runs from the repository root on every machine that clones the repository, `
      + `so it cannot name a path that only exists on one machine: ${listed}. `
      + 'Name the file relative to the repository instead (for example `./scripts/verify.sh`).',
    );
  }
  return trimmed;
}

const validMode = (input: unknown): ReceiptsMode => {
  if (typeof input !== 'string' || !(RECEIPTS_MODES as readonly string[]).includes(input)) {
    throw new RepoSettingsError('invalid_mode', `mode must be one of ${RECEIPTS_MODES.join(', ')}`);
  }
  return input as ReceiptsMode;
};

/** A stored mode, read defensively: anything but 'all' is the allowlist, the narrower answer. */
const producerModeOf = (v: unknown): ProducerMode => (String(v) === 'all' ? 'all' : 'listed');

const validProducerMode = (input: unknown): ProducerMode => {
  if (typeof input !== 'string' || !(PRODUCER_MODES as readonly string[]).includes(input)) {
    throw new RepoSettingsError('invalid_producer_mode', `producerMode must be one of ${PRODUCER_MODES.join(', ')}`);
  }
  return input as ProducerMode;
};

/** A threshold is a positive whole number, or null to clear it. */
const validThreshold = (input: unknown): number | null => {
  if (input === null) return null;
  const n = typeof input === 'string' && input.trim() ? Number(input) : typeof input === 'number' ? input : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new RepoSettingsError('invalid_threshold', 'shadowThreshold must be a positive whole number');
  return n;
};

/** The producers row set for one repo, as the sorted list the view carries. */
async function producersOf(db: HubDb, orgId: string, remoteUrl: string): Promise<string[]> {
  const rows = await db.all<{ installation_id: string }>(
    'SELECT installation_id FROM repo_producers WHERE org_id = ? AND remote_url = ?',
    [orgId, remoteUrl],
  );
  return rows.map(r => String(r.installation_id)).sort();
}

async function rowOf(db: HubDb, orgId: string, remoteUrl: string): Promise<SettingsRow | undefined> {
  return await db.get<SettingsRow>(
    `SELECT remote_url, verify_command, revision, receipts_mode, shadow_threshold, producer_mode, created_at, updated_at
     FROM repo_settings WHERE org_id = ? AND remote_url = ?`,
    [orgId, remoteUrl],
  );
}

/** The view of a row that must exist (after a write). */
async function viewOf(db: HubDb, orgId: string, remoteUrl: string): Promise<RepoSettingsView> {
  const row = await rowOf(db, orgId, remoteUrl);
  if (!row) throw new RepoSettingsError('not_found', 'no settings for this repository');
  return toView(row, await producersOf(db, orgId, remoteUrl));
}

/**
 * A row plus its producers, as the view. `revision` and `shadow_threshold` go
 * through `Number()` because the PG adapter can hand back either as a string;
 * a null threshold stays null — it means "nobody has set one", not zero.
 */
function toView(row: SettingsRow, producers: string[]): RepoSettingsView {
  return {
    remoteUrl: String(row.remote_url),
    verifyCommand: String(row.verify_command),
    revision: Number(row.revision),
    receiptsMode: String(row.receipts_mode) as ReceiptsMode,
    shadowThreshold: intOrNull(row.shadow_threshold),
    producerMode: producerModeOf(row.producer_mode),
    producers,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** One repo's settings, or null when the org has never claimed it. */
export async function getRepoSettings(db: HubDb, orgId: string, repo: unknown): Promise<RepoSettingsView | null> {
  const remoteUrl = canonicalRepo(repo);
  const row = await rowOf(db, orgId, remoteUrl);
  if (!row) return null;
  return toView(row, await producersOf(db, orgId, remoteUrl));
}

/** Every repo the org has claimed, in canonical-URL order. */
export async function listRepoSettings(db: HubDb, orgId: string): Promise<RepoSettingsView[]> {
  const rows = await db.all<SettingsRow>(
    `SELECT remote_url, verify_command, revision, receipts_mode, shadow_threshold, producer_mode, created_at, updated_at
     FROM repo_settings WHERE org_id = ? ORDER BY remote_url`,
    [orgId],
  );
  const producers = await db.all<{ remote_url: string; installation_id: string }>(
    'SELECT remote_url, installation_id FROM repo_producers WHERE org_id = ?',
    [orgId],
  );
  const byRepo = new Map<string, string[]>();
  for (const p of producers) {
    const list = byRepo.get(String(p.remote_url)) ?? [];
    list.push(String(p.installation_id));
    byRepo.set(String(p.remote_url), list);
  }
  return rows.map(r => toView(r, (byRepo.get(String(r.remote_url)) ?? []).sort()));
}

export interface InitResult {
  settings: RepoSettingsView;
  /** True only for the caller whose insert created the record. */
  created: boolean;
}

/**
 * Claim the repo's verify command, first-writer-wins.
 *
 * One transaction: `INSERT OR IGNORE` the settings row and write the revision-1
 * history row ONLY when that insert actually changed a row. A losing caller
 * therefore walks away with the winner's settings unchanged and writes nothing
 * at all — not a second revision, not a new `updated_at`. `INSERT OR IGNORE`
 * has no PG spelling, so the dialect translator turns it into
 * `ON CONFLICT DO NOTHING`; `changes` is the row count either way, which is
 * what makes the winner detectable in both dialects.
 */
export async function initRepoCommand(
  db: HubDb,
  orgId: string,
  repo: unknown,
  command: unknown,
  installationId: string | null,
): Promise<InitResult> {
  const remoteUrl = canonicalRepo(repo);
  const verifyCommand = validCommand(command);
  const at = nowIso();
  let created = false;

  await db.transaction(async () => {
    const inserted = await db.run(
      `INSERT OR IGNORE INTO repo_settings
         (org_id, remote_url, verify_command, revision, receipts_mode, shadow_threshold, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'off', NULL, ?, ?)`,
      [orgId, remoteUrl, verifyCommand, at, at],
    );
    created = inserted.changes === 1;
    if (created) {
      await db.run(
        `INSERT INTO repo_command_revisions
           (org_id, remote_url, revision, verify_command, source, actor_user_id, actor_email, installation_id, created_at)
         VALUES (?, ?, 1, ?, 'init', NULL, NULL, ?, ?)`,
        [orgId, remoteUrl, verifyCommand, installationId, at],
      );
    }
  });

  // Read back after the transaction: the winner's own row, or the row the
  // other caller wrote first. Either way the loser changed nothing.
  return { settings: await viewOf(db, orgId, remoteUrl), created };
}

/**
 * An admin changes the command. Same command as current: no new revision, so a
 * page that re-saves what it shows does not spam the history.
 *
 * The read and the write are ONE transaction, and the counter moves to
 * `base + 1` where `base` is the revision read inside that transaction. Two
 * admins saving different commands in the same moment otherwise both read
 * revision 1, both compute revision 2, and one of them dies on the history
 * table's primary key — a 500 that says nothing about the other admin's save
 * having gone through. `reviseRepoCommand` makes the two admins take turns; this
 * function makes one of them correct.
 *
 * It is written for a transaction it can trust, and this is the shape of that
 * trust worth spelling out, because the hub's two backends do not give it for
 * nothing:
 *
 * - PostgreSQL aborts one side of a write-write cycle with SQLSTATE 40001,
 *   having written nothing. Retrying after re-reading is the correct response,
 *   and `retryTransaction` does exactly one round of it.
 * - SQLite answers `database is locked` while a writer holds the write lock,
 *   and it serialises two writers outright, so the loser has nothing to undo.
 * - pg-mem, the in-memory backend the hub's tests run, models neither, because
 *   its pg adapter hands every `connect()` the SAME client (measured:
 *   `c1 === c2`). Two "separate" transactions are then one BEGIN on one
 *   connection: each side's `UPDATE ... revision = base + 1` lands, the second
 *   overwriting the first's absolute value, and no error is raised at all.
 *   Reads inside a transaction see the other caller's row, so a read-back
 *   cannot be trusted as "mine", and `ROLLBACK` does not undo (already noted in
 *   `hubdb-postgres.test.ts`). Concurrency is therefore not testable through
 *   pg-mem, and this function does not pretend to be exercised that way — the
 *   route above the service keeps one org's revisions to one at a time, in this
 *   single process, which is what makes the behaviour observable and correct
 *   where the hub actually runs.
 *
 * So: one transaction, an absolute revision taken from the row inside it, a
 * history row keyed to that same number, and one retry of a transaction the
 * store says to redo. Nothing here guesses at concurrency it cannot see.
 */
export async function reviseRepoCommand(
  db: HubDb,
  orgId: string,
  repo: unknown,
  command: unknown,
  actor: RepoCommandActor = {},
): Promise<RepoSettingsView> {
  const remoteUrl = canonicalRepo(repo);
  const verifyCommand = validCommand(command);

  await retryTransaction(() => writeRepoCommand(db, orgId, remoteUrl, verifyCommand, actor));
  return viewOf(db, orgId, remoteUrl);
}

const nap = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/** How many times a transaction the store refused is attempted in all. */
const TRANSACTION_ATTEMPTS = 2;

/**
 * Run a transaction, and run it once more if the store refused it as a
 * conflict: PostgreSQL's serialisation failure (40001) or SQLite's write lock
 * (`database is locked` / SQLITE_BUSY). Both mean "nothing of yours was
 * written; read it again and go". A retry of anything else — a duplicate key,
 * this service's own `not_found` — would only repeat a mistake, so it is
 * handed straight to the caller.
 *
 * `write` opens the transaction itself rather than being handed one, so a retry
 * is a new transaction with a fresh read of the row, never a statement on the
 * corpse of the one that was refused.
 */
async function retryTransaction(write: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await write();
      return;
    } catch (e) {
      if (attempt >= TRANSACTION_ATTEMPTS || !retryableConflict(e)) throw e;
      await nap(5);
    }
  }
}

/** Did the store refuse this because a transaction of ours overlapped another? */
function retryableConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === '40001') return true;
  return /serialization failure|could not serialize|database is locked|database is busy/i.test(e.message);
}

/**
 * The write, in one transaction. The UPDATE is what claims the revision: it
 * takes the row's lock, so the database itself orders concurrent revisions and
 * each writer's `revision + 1` is computed against the value it actually held.
 */
async function writeRepoCommand(
  db: HubDb,
  orgId: string,
  remoteUrl: string,
  verifyCommand: string,
  actor: RepoCommandActor,
): Promise<void> {
  const at = nowIso();
  // `retryTransaction` calls this once per transaction. The UPDATE carries the
  // same-command no-op in its own WHERE clause, and it is the UPDATE's row lock
  // that makes the revision it just wrote the revision this write owns.
  const write = async (): Promise<void> => {
    const bumped = await db.run(
      `UPDATE repo_settings SET verify_command = ?, revision = revision + 1, updated_at = ?
       WHERE org_id = ? AND remote_url = ? AND verify_command <> ?`,
      [verifyCommand, at, orgId, remoteUrl, verifyCommand],
    );
    if (bumped.changes === 0) {
      // Either the repo has no record, or the command is already this one (a no-op).
      if (!(await rowOf(db, orgId, remoteUrl))) throw new RepoSettingsError('not_found', 'this repository has no settings yet');
      return;
    }
    // Our own write, read inside our own transaction, under the lock we hold.
    const row = await rowOf(db, orgId, remoteUrl);
    const revision = Number(row!.revision);
    await db.run(
      `INSERT INTO repo_command_revisions
         (org_id, remote_url, revision, verify_command, source, actor_user_id, actor_email, installation_id, created_at)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, NULL, ?)`,
      [orgId, remoteUrl, revision, verifyCommand, actor.userId ?? null, actor.email ?? null, at],
    );
  };

  await db.transaction(write);
}

/** The command's history, newest first. */
export async function listRevisions(db: HubDb, orgId: string, repo: unknown): Promise<RepoCommandRevision[]> {
  const remoteUrl = canonicalRepo(repo);
  const rows = await db.all<{
    revision: unknown; verify_command: string; source: string;
    actor_email: string | null; installation_id: string | null; created_at: string;
  }>(
    `SELECT revision, verify_command, source, actor_email, installation_id, created_at
     FROM repo_command_revisions WHERE org_id = ? AND remote_url = ?
     ORDER BY revision DESC`,
    [orgId, remoteUrl],
  );
  return rows.map(r => ({
    revision: Number(r.revision),
    verifyCommand: String(r.verify_command),
    source: String(r.source) as 'init' | 'admin',
    actorEmail: r.actor_email ?? null,
    installationId: r.installation_id ?? null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Set the CI receipts mode.
 *
 * A threshold omitted from the request keeps the stored value; `enforce` is
 * refused while the repo has none, because enforcing against no floor would
 * gate every receipt on nothing.
 */
export async function setReceiptsMode(
  db: HubDb,
  orgId: string,
  repo: unknown,
  opts: { mode: unknown; shadowThreshold?: unknown },
): Promise<RepoSettingsView> {
  const remoteUrl = canonicalRepo(repo);
  const mode = validMode(opts.mode);
  const current = await rowOf(db, orgId, remoteUrl);
  if (!current) throw new RepoSettingsError('not_found', 'this repository has no settings yet');
  const threshold = opts.shadowThreshold === undefined
    ? intOrNull(current.shadow_threshold)
    : validThreshold(opts.shadowThreshold);
  if (mode === 'enforce' && threshold === null) {
    throw new RepoSettingsError('threshold_required', 'enforce needs a shadow threshold; set one first');
  }
  await db.run(
    'UPDATE repo_settings SET receipts_mode = ?, shadow_threshold = ?, updated_at = ? WHERE org_id = ? AND remote_url = ?',
    [mode, threshold, nowIso(), orgId, remoteUrl],
  );
  return viewOf(db, orgId, remoteUrl);
}

/**
 * Add or remove an installation from the repo's producer allowlist.
 *
 * The installation must belong to THIS org: a producer id from another org
 * would be a row this org can never manage or explain.
 */
export async function setProducer(
  db: HubDb,
  orgId: string,
  repo: unknown,
  installationId: unknown,
  allowed: boolean,
  actorEmail: string | null,
): Promise<RepoSettingsView> {
  const remoteUrl = canonicalRepo(repo);
  if (typeof installationId !== 'string' || !installationId.trim()) {
    throw new RepoSettingsError('unknown_installation', 'installationId is required');
  }
  const id = installationId.trim();
  const current = await rowOf(db, orgId, remoteUrl);
  if (!current) throw new RepoSettingsError('not_found', 'this repository has no settings yet');
  const known = await db.get<{ id: string }>(
    'SELECT id FROM installations WHERE id = ? AND org_id = ?',
    [id, orgId],
  );
  if (!known) throw new RepoSettingsError('unknown_installation', 'no such installation for this organisation');

  if (allowed) {
    // Idempotent: re-adding a producer is not an error and does not move the
    // record's updated_at.
    await db.run(
      'INSERT OR IGNORE INTO repo_producers (org_id, remote_url, installation_id, added_at, added_by_email) VALUES (?, ?, ?, ?, ?)',
      [orgId, remoteUrl, id, nowIso(), actorEmail],
    );
  } else {
    await db.run(
      'DELETE FROM repo_producers WHERE org_id = ? AND remote_url = ? AND installation_id = ?',
      [orgId, remoteUrl, id],
    );
  }
  return viewOf(db, orgId, remoteUrl);
}

/**
 * Switch who may produce the repository's receipts (RFC-002 Amendment 1).
 * The allowlist rows are not touched in either direction: under `all` they wait
 * for the switch back, which is what makes the switch reversible.
 */
export async function setProducerMode(
  db: HubDb,
  orgId: string,
  repo: unknown,
  producerMode: unknown,
): Promise<RepoSettingsView> {
  const remoteUrl = canonicalRepo(repo);
  const mode = validProducerMode(producerMode);
  await db.run(
    'UPDATE repo_settings SET producer_mode = ?, updated_at = ? WHERE org_id = ? AND remote_url = ?',
    [mode, nowIso(), orgId, remoteUrl],
  );
  // A repository the org has no row for updated nothing; viewOf answers not_found.
  return viewOf(db, orgId, remoteUrl);
}

/** Answers "may this installation produce receipts for this repository, now?". */
export type ProducerCheck = (installationId: string) => boolean;

/**
 * The repository's producer rule as it stands NOW, as a check over
 * installation ids - what the publish decision and every CI read ask.
 *
 * Under `listed` it is membership of the allowlist, exactly as before the mode
 * existed. Under `all` it is "an installation of THIS org that is not retired",
 * read live from `installations`, so a machine that joined since counts and a
 * retired one does not, with no row of the repository's own to keep in step.
 *
 * A repository with no settings row has no producers at all.
 *
 * Only the `candidates` the caller is about to judge are looked up (by primary
 * key, under `all`), so a read costs the receipts it returns, not the size of
 * the org's fleet. Any id outside `candidates` answers false.
 */
export async function producerCheckOf(
  db: HubDb,
  orgId: string,
  remoteUrl: string,
  candidates: readonly string[],
): Promise<ProducerCheck> {
  const ids = [...new Set(candidates)];
  if (ids.length === 0) return () => false;
  const row = await db.get<{ producer_mode: string }>(
    'SELECT producer_mode FROM repo_settings WHERE org_id = ? AND remote_url = ?',
    [orgId, remoteUrl],
  );
  if (!row) return () => false;
  const marks = ids.map(() => '?').join(', ');
  // Under 'all' the producers are the org's live installations; under 'listed', the allowlist rows.
  const rows = producerModeOf(row.producer_mode) === 'all'
    ? await db.all<{ id: string }>(
      `SELECT id FROM installations WHERE org_id = ? AND retired_at IS NULL AND id IN (${marks})`,
      [orgId, ...ids],
    )
    : await db.all<{ id: string }>(
      `SELECT installation_id AS id FROM repo_producers WHERE org_id = ? AND remote_url = ? AND installation_id IN (${marks})`,
      [orgId, remoteUrl, ...ids],
    );
  const allowed = new Set(rows.map(r => String(r.id)));
  return (installationId: string) => allowed.has(installationId);
}
