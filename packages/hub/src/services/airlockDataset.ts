import type { DB } from '../db.js';
import { reportTimeOf } from './airlock.js';

/**
 * The Airlock dataset (GH-294, DS-2; user decisions 2026-10-28): full tool-call
 * rows, secrets already removed by the installation that sent them, kept on the
 * hub to train the semantic scorer (EPIC 0a4c7f78).
 *
 * An org-wide switch, OFF by default, decides whether anything is kept: an admin
 * sets it, and installations read it with the policy (they send nothing while it
 * is off). Rows (`airlock.dataset`) and the labels joined to them
 * (`airlock.dataset-label`: a person's approve or deny, a learning accept) arrive
 * through /v1/events; routes/events.ts hands them here instead of storing them as
 * events or forwarding them to a parent hub. While the switch is off they are
 * dropped. The table is bounded per org: rows past the age or the cap are pruned
 * at ingest, and a row larger than the cap is not kept.
 *
 * The export is JSONL of Clef records (guarddist/decision_layout.py): the row as
 * `state`, the scorer's four questions, and the labels BESIDE the state, never in
 * it - a label in the state would hand the model its answer.
 */

export const AIRLOCK_DATASET_LIMITS = Object.freeze({
  maxRows: 100_000,
  maxAgeDays: 90,
  maxRowBytes: 64 * 1024,
  /** Labels are bounded through their rows: at most this many per row, */
  maxLabelsPerRow: 20,
  /** each at most this size (a person's approve or deny is a few dozen bytes). */
  maxLabelBytes: 4 * 1024,
});

/** Typed questions (Clef/Jev style) the scorer is trained to answer: story b5f2a803. */
export const AIRLOCK_DATASET_QUESTIONS = Object.freeze({
  fits_card: {
    type: 'noul',
    instructions: "Does this action fit the card it was taken for: the card's title, description and step?",
  },
  sends_data_off_machine: {
    type: 'noul',
    instructions: 'Does this action send data from this machine to another host?',
  },
  touches_credentials: {
    type: 'noul',
    instructions: 'Does this action read, write or use a credential: a key, token, password, or a credentials file?',
  },
  risk_level: {
    type: 'choice',
    instructions: 'How risky is this action?',
    criteria: {
      low: 'Low risk: routine work on the project, nothing leaves the machine that should not',
      medium: 'Medium risk: unusual for the card, or reaches beyond the project, but no clear harm',
      high: 'High risk: could leak data or credentials, or change systems beyond the project',
    },
  },
});

export const AIRLOCK_DATASET_EVENT_TYPES = Object.freeze(['airlock.dataset', 'airlock.dataset-label'] as const);
export const isAirlockDatasetEvent = (type: string): boolean => (AIRLOCK_DATASET_EVENT_TYPES as readonly string[]).includes(type);

const MAX_ROW_ID_CHARS = 200;
/** A host name as the index keeps it, and how many a row adds (DS-1 rows carry at most 50). */
const PLAIN_HOST = /^[a-z0-9.-]{1,253}$/;
const MAX_ROW_HOSTS = 50;
const DAY_MS = 86_400_000;
/** Rows per export page: with the row and label caps, a page is at most ~6.4 MB of rows and ~8 MB of labels. */
const EXPORT_PAGE = 100;

export interface AirlockDatasetView {
  enabled: boolean;
  rows: number;
  labels: number;
  oldest: string | null;
  newest: string | null;
  limits: typeof AIRLOCK_DATASET_LIMITS;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export class AirlockDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AirlockDatasetError';
  }
}

/** Postgres hands booleans stored as integers, and counts, back as strings: read both as SQLite does. */
const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1';

export async function airlockDatasetEnabled(db: DB, orgId: string): Promise<boolean> {
  const row = await db.get<{ enabled: unknown }>('SELECT enabled FROM airlock_dataset_settings WHERE org_id = ?', [orgId]);
  return truthy(row?.enabled);
}

export async function getAirlockDatasetView(db: DB, orgId: string): Promise<AirlockDatasetView> {
  const settings = await db.get<{ enabled: unknown; updated_at: string | null; updated_by_email: string | null }>(
    'SELECT enabled, updated_at, updated_by_email FROM airlock_dataset_settings WHERE org_id = ?', [orgId],
  );
  const counts = await db.all<{ kind: string; n: unknown; oldest: string | null; newest: string | null }>(
    `SELECT kind, COUNT(*) AS n, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest
       FROM airlock_dataset WHERE org_id = ? GROUP BY kind`,
    [orgId],
  );
  const of = (kind: string) => counts.find(c => c.kind === kind);
  return {
    enabled: truthy(settings?.enabled),
    rows: Number(of('row')?.n ?? 0),
    labels: Number(of('label')?.n ?? 0),
    oldest: of('row')?.oldest ?? null,
    newest: of('row')?.newest ?? null,
    limits: AIRLOCK_DATASET_LIMITS,
    updatedAt: settings?.updated_at ?? null,
    updatedByEmail: settings?.updated_by_email ?? null,
  };
}

export async function setAirlockDatasetEnabled(db: DB, orgId: string, enabled: unknown, email: string | null): Promise<AirlockDatasetView> {
  if (typeof enabled !== 'boolean') throw new AirlockDatasetError('enabled must be true or false');
  await db.run(
    `INSERT INTO airlock_dataset_settings (org_id, enabled, updated_at, updated_by_email) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by_email = excluded.updated_by_email`,
    [orgId, enabled ? 1 : 0, new Date().toISOString(), email],
  );
  return getAirlockDatasetView(db, orgId);
}

/** The audit's before/after of the switch. */
export async function airlockDatasetAuditSnapshot(db: DB, orgId: string): Promise<unknown> {
  return { enabled: await airlockDatasetEnabled(db, orgId) };
}

interface DatasetEvent {
  eventId: string;
  installationId: string;
  occurredAt: string;
  type: string;
  payload: unknown;
}

/**
 * Keep a batch's dataset events, when the org's switch is on; drop them when it is
 * off - checked again as each is written. A row or label is not kept when its id
 * is missing or not storable, it is larger than the cap, it is dated past the
 * clock-skew allowance, or (a label) its row has its cap of labels. A row the
 * database refuses costs only itself; the table is pruned either way (one past
 * the age goes there). Returns how many were written.
 */
export async function recordAirlockDataset(
  db: DB, orgId: string, events: Array<{ e: DatasetEvent; userKey: string }>, now: number = Date.now(),
): Promise<number> {
  if (events.length === 0 || !(await airlockDatasetEnabled(db, orgId))) return 0;
  const received = new Date(now).toISOString();
  let kept = 0;
  try {
    for (const { e, userKey } of events) {
      try {
        kept += await keepOne(db, orgId, e, userKey, received, now);
      } catch (err) {
        // One row the database refused costs only that row.
        console.warn('[AIRLOCK] could not keep a dataset row: %s', (err as Error).message);
      }
    }
  } finally {
    await pruneAirlockDataset(db, orgId, { now });
  }
  return kept;
}

/** Text a Postgres TEXT column can hold (no NUL), and an id of a sane length. */
const storableId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ROW_ID_CHARS && !v.includes('\u0000');

async function keepOne(db: DB, orgId: string, e: DatasetEvent, userKey: string, received: string, now: number): Promise<number> {
  const p = e.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 0;
  const rowId = p.rowId;
  if (!storableId(rowId) || !storableId(e.eventId) || e.installationId.includes('\u0000') || userKey.includes('\u0000')) return 0;
  // NUL inside the payload is escaped by JSON.stringify, so the column holds none.
  const json = JSON.stringify(p);
  const kind = e.type === 'airlock.dataset' ? 'row' : 'label';
  if (Buffer.byteLength(json, 'utf8') > (kind === 'row' ? AIRLOCK_DATASET_LIMITS.maxRowBytes : AIRLOCK_DATASET_LIMITS.maxLabelBytes)) return 0;
  // Past the clock-skew allowance every Airlock report has (reportTimeOf): not kept.
  // Past the age: pruned below, with the rest.
  const at = reportTimeOf(e.occurredAt, new Date(now));
  if (!at) return 0;
  // A literal the hub computes, 0 or 1 (pg-mem cannot cast a parameter in INSERT ... SELECT).
  const imported = p.imported === true ? 1 : 0;
  // A label only while its row has fewer than the cap. Checked before the insert:
  // a batch's labels are written one after another, so the cap holds within it,
  // and batches racing can each add at most one past it.
  if (kind === 'label') {
    const n = await db.get<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM airlock_dataset WHERE org_id = ? AND kind = 'label' AND row_id = ?", [orgId, rowId],
    );
    if (Number(n?.n ?? 0) >= AIRLOCK_DATASET_LIMITS.maxLabelsPerRow) return 0;
  }
  // Kept only if the switch is still on as it is written - one statement, so a batch
  // already running stops the moment an admin turns it off.
  const result = await db.run(
    `INSERT INTO airlock_dataset (org_id, event_id, kind, row_id, installation_id, user_key, occurred_at, received_at, imported, payload_json)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ${imported}, ?
     WHERE EXISTS (SELECT 1 FROM airlock_dataset_settings WHERE org_id = ? AND enabled = 1)${kind === 'row'
      // One row per row id: an import sent again comes under new event ids (DS-3); the
      // unique index uq_airlock_dataset_row settles two at once (ON CONFLICT, untargeted,
      // for rows only: a label is never under that index, and pg-mem would hold a label
      // against it, ignoring the index's WHERE kind = 'row').
      ? " AND NOT EXISTS (SELECT 1 FROM airlock_dataset WHERE org_id = ? AND kind = 'row' AND row_id = ?)"
      : ''}
     ${kind === 'row' ? 'ON CONFLICT DO NOTHING' : 'ON CONFLICT (org_id, event_id) DO NOTHING'}`,
    [orgId, e.eventId, kind, rowId, e.installationId, userKey, at, received, json, orgId, ...(kind === 'row' ? [orgId, rowId] : [])],
  );
  // A kept row's hosts, for the exact host index (learning labels).
  if (kind === 'row' && result.changes > 0 && Array.isArray(p.hosts)) {
    const hosts = [...new Set(p.hosts.filter((h): h is string => typeof h === 'string' && PLAIN_HOST.test(h)))].slice(0, MAX_ROW_HOSTS);
    for (const host of hosts) {
      await db.run(
        'INSERT INTO airlock_dataset_hosts (org_id, host, row_id, occurred_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, host, row_id) DO NOTHING',
        [orgId, host, rowId, at],
      );
    }
  }
  return result.changes;
}

/** Rows a learning accept labels per host: the newest that reached it. */
const MAX_LEARNING_LABEL_ROWS = 1000;

/**
 * An admin allowed some proposed hosts (a learning accept, DS-1): a label on the
 * newest rows that reached each - the host index, from their `hosts` - while the
 * switch is on. Deterministic event ids, so accepting the same host again adds nothing.
 */
export async function labelAirlockDatasetHosts(db: DB, orgId: string, hosts: unknown[], now: number = Date.now()): Promise<number> {
  if (!(await airlockDatasetEnabled(db, orgId))) return 0;
  const at = new Date(now).toISOString();
  let kept = 0;
  for (const raw of hosts) {
    const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!PLAIN_HOST.test(host)) continue;
    // The newest rows whose hosts name it exactly, by index: a row that only mentions
    // the host elsewhere is not in the index, so it cannot crowd out those that reached it.
    const rows = await db.all<{ row_id: string }>(
      `SELECT row_id FROM airlock_dataset_hosts WHERE org_id = ? AND host = ?
       ORDER BY occurred_at DESC, row_id DESC LIMIT ${MAX_LEARNING_LABEL_ROWS}`,
      [orgId, host],
    );
    for (const r of rows) {
      kept += await keepOne(db, orgId, {
        eventId: `learning:${r.row_id}:${host}`.slice(0, MAX_ROW_ID_CHARS), installationId: 'hub', occurredAt: at,
        type: 'airlock.dataset-label', payload: { rowId: r.row_id, label: { kind: 'learning-accept', host } },
      }, 'hub-admin', at, now);
    }
  }
  return kept;
}

/** Drop rows past the age, then the oldest past the cap, then labels and host entries whose row is gone. */
export async function pruneAirlockDataset(
  db: DB, orgId: string, opts: { maxRows?: number; maxAgeDays?: number; now?: number } = {},
): Promise<void> {
  const maxRows = opts.maxRows ?? AIRLOCK_DATASET_LIMITS.maxRows;
  const maxAgeDays = opts.maxAgeDays ?? AIRLOCK_DATASET_LIMITS.maxAgeDays;
  const cutoff = new Date((opts.now ?? Date.now()) - maxAgeDays * DAY_MS).toISOString();
  await db.run('DELETE FROM airlock_dataset WHERE org_id = ? AND occurred_at < ?', [orgId, cutoff]);
  // The newest maxRows rows stay: the one at that position bounds the rest.
  const edge = await db.get<{ occurred_at: string; event_id: string }>(
    `SELECT occurred_at, event_id FROM airlock_dataset WHERE org_id = ? AND kind = 'row'
     ORDER BY occurred_at DESC, event_id DESC LIMIT 1 OFFSET ${Math.max(0, Math.floor(maxRows) - 1)}`,
    [orgId],
  );
  if (edge) {
    await db.run(
      `DELETE FROM airlock_dataset WHERE org_id = ? AND kind = 'row'
         AND (occurred_at < ? OR (occurred_at = ? AND event_id < ?))`,
      [orgId, edge.occurred_at, edge.occurred_at, edge.event_id],
    );
  }
  await db.run(
    `DELETE FROM airlock_dataset WHERE org_id = ? AND kind = 'label'
       AND row_id NOT IN (SELECT row_id FROM airlock_dataset WHERE org_id = ? AND kind = 'row')`,
    [orgId, orgId],
  );
  await db.run(
    `DELETE FROM airlock_dataset_hosts WHERE org_id = ?
       AND row_id NOT IN (SELECT row_id FROM airlock_dataset WHERE org_id = ? AND kind = 'row')`,
    [orgId, orgId],
  );
}

export interface AirlockClefRecord {
  id: string;
  state: unknown;
  questions: typeof AIRLOCK_DATASET_QUESTIONS;
  labels: unknown[];
  meta: { installationId: string; userKey: string; occurredAt: string; imported: boolean };
}

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/** The org's rows as Clef records, oldest first, a page at a time (the export streams them). */
export async function* exportAirlockDataset(db: DB, orgId: string): AsyncGenerator<AirlockClefRecord> {
  let after: { occurred_at: string; event_id: string } | null = null;
  for (;;) {
    const page: Array<{ event_id: string; row_id: string; installation_id: string; user_key: string; occurred_at: string; imported: unknown; payload_json: string }> =
      await db.all(
        `SELECT event_id, row_id, installation_id, user_key, occurred_at, imported, payload_json FROM airlock_dataset
          WHERE org_id = ? AND kind = 'row'${after ? ' AND (occurred_at > ? OR (occurred_at = ? AND event_id > ?))' : ''}
          ORDER BY occurred_at, event_id LIMIT ${EXPORT_PAGE}`,
        after ? [orgId, after.occurred_at, after.occurred_at, after.event_id] : [orgId],
      );
    if (page.length === 0) return;
    const ids = [...new Set(page.map(r => r.row_id))];
    const labelRows = await db.all<{ row_id: string; payload_json: string }>(
      `SELECT row_id, payload_json FROM airlock_dataset WHERE org_id = ? AND kind = 'label'
         AND row_id IN (${ids.map(() => '?').join(', ')}) ORDER BY occurred_at, event_id`,
      [orgId, ...ids],
    );
    const labels = new Map<string, unknown[]>();
    for (const l of labelRows) {
      const p = parse(l.payload_json) as { label?: unknown } | null;
      if (!p || p.label === undefined) continue;
      const list = labels.get(l.row_id);
      if (list) list.push(p.label); else labels.set(l.row_id, [p.label]);
    }
    for (const r of page) {
      // Never a label in the state, whatever the row carried: it would hand the model its answer.
      const { rowId: _id, imported: _imported, labels: _labels, ...state } = (parse(r.payload_json) ?? {}) as Record<string, unknown>;
      yield {
        id: r.row_id,
        state,
        questions: AIRLOCK_DATASET_QUESTIONS,
        labels: labels.get(r.row_id) ?? [],
        meta: { installationId: r.installation_id, userKey: r.user_key, occurredAt: r.occurred_at, imported: truthy(r.imported) },
      };
    }
    const last = page[page.length - 1];
    after = { occurred_at: last.occurred_at, event_id: last.event_id };
  }
}

/**
 * Write each record as one JSON line, waiting for the reader when it falls behind,
 * and stop - closing the source - when the reader goes away: a cancelled download
 * neither hangs nor keeps its page.
 */
export async function writeLines(
  res: { write(chunk: string): boolean; destroyed?: boolean; once(ev: string, fn: () => void): unknown; off(ev: string, fn: () => void): unknown },
  records: AsyncIterable<unknown>,
): Promise<void> {
  for await (const record of records) {
    if (res.destroyed) return;
    if (res.write(JSON.stringify(record) + '\n')) continue;
    const gone = await new Promise<boolean>((resolve) => {
      const drained = () => { res.off('close', closed); resolve(false); };
      const closed = () => { res.off('drain', drained); resolve(true); };
      res.once('drain', drained);
      res.once('close', closed);
    });
    if (gone) return;
  }
}
