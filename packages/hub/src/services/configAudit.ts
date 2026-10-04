import { randomUUID } from 'crypto';
import type { DB } from '../db.js';

/**
 * The hub's config audit log (STORY a89af514): who changed which setting,
 * when, from where, and from what to what.
 *
 * Append-only and kept forever (the user's call, 2026-10-04): nothing here
 * updates or deletes a row, and no route does. A secret never reaches a row -
 * a secret-looking field reads "[secret]", or "[secret: changed]" when it
 * moved - so the log can be read and exported without becoming a leak.
 */

/** Where a change came from. */
export type AuditSource = 'board' | 'api-key' | 'cli' | 'federation' | 'system';

export interface AuditEntry {
  orgId: string;
  actor: { userId: string | null; email: string | null } | null;
  source: AuditSource;
  ip: string | null;
  /** The settings area, as the Audit tab filters it: flows, sign-in, users, ... */
  area: string;
  /** What was done, e.g. flow.update. */
  action: string;
  /** What it was done to, in words: "flow Main (f-1)". */
  target: string | null;
  before: unknown;
  after: unknown;
  /** Where an older, partial trail of the same change lives on the board, if any. */
  link?: string | null;
  /** Defaults to now; set by tests. */
  at?: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  source: AuditSource;
  ip: string | null;
  area: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  link: string | null;
}

// A key that names a secret. Booleans (passwordEnabled) and nulls are settings, not secrets.
const SECRET_KEY = /(secret|password|passwd|token|private|credential|api[-_]?key)/i;
const isSecretValue = (v: unknown) => v !== null && v !== undefined && typeof v !== 'boolean';
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `before` and `after` with every secret value replaced, saying whether it changed. */
export function redactPair(before: unknown, after: unknown): { before: unknown; after: unknown } {
  const walk = (b: unknown, a: unknown): { b: unknown; a: unknown } => {
    if (Array.isArray(b) || Array.isArray(a)) {
      const ba = Array.isArray(b) ? b : [];
      const aa = Array.isArray(a) ? a : [];
      const n = Math.max(ba.length, aa.length);
      const outB: unknown[] = [], outA: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const w = walk(ba[i], aa[i]);
        if (i < ba.length) outB.push(w.b);
        if (i < aa.length) outA.push(w.a);
      }
      return { b: Array.isArray(b) ? outB : b, a: Array.isArray(a) ? outA : a };
    }
    if (!isPlainObject(b) && !isPlainObject(a)) return { b, a };
    const bo = isPlainObject(b) ? b : {};
    const ao = isPlainObject(a) ? a : {};
    const outB: Record<string, unknown> = {}, outA: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
      const inB = key in bo, inA = key in ao;
      if (SECRET_KEY.test(key) && (isSecretValue(bo[key]) || isSecretValue(ao[key])) && !isPlainObject(bo[key]) && !isPlainObject(ao[key])) {
        if (inB) outB[key] = isSecretValue(bo[key]) ? '[secret]' : bo[key];
        if (inA) outA[key] = !isSecretValue(ao[key]) ? ao[key] : inB && JSON.stringify(bo[key]) !== JSON.stringify(ao[key]) ? '[secret: changed]' : '[secret]';
        continue;
      }
      const w = walk(bo[key], ao[key]);
      if (inB) outB[key] = w.b;
      if (inA) outA[key] = w.a;
    }
    return { b: isPlainObject(b) ? outB : b, a: isPlainObject(a) ? outA : a };
  };
  const w = walk(before, after);
  return { before: w.b, after: w.a };
}

/** Appends one row. Never throws into the change it records: a failed write is logged, not fatal. */
export async function recordAudit(db: DB, e: AuditEntry): Promise<void> {
  const { before, after } = redactPair(e.before ?? null, e.after ?? null);
  try {
    await db.run(
      `INSERT INTO config_audit (id, org_id, at, actor_user_id, actor_email, source, ip, area, action, target, before_json, after_json, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), e.orgId, e.at ?? new Date().toISOString(), e.actor?.userId ?? null, e.actor?.email ?? null, e.source, e.ip,
        e.area, e.action, e.target, before === null || before === undefined ? null : JSON.stringify(before),
        after === null || after === undefined ? null : JSON.stringify(after), e.link ?? null],
    );
  } catch (err) {
    console.error(`[HUB] Could not record the audit row for ${e.action}:`, (err as Error).message);
  }
}

export interface AuditFilter {
  area?: string;
  /** A part of the actor's email, any case. */
  actor?: string;
  /** Inclusive ISO bounds. */
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export const AUDIT_PAGE_MAX = 200;
const AUDIT_PAGE_DEFAULT = 50;

const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'string') ? [v[0], v[1]] : null;
  } catch { return null; }
}

const parseJson = (s: unknown): unknown => {
  if (s === null || s === undefined) return null;
  try { return JSON.parse(String(s)); } catch { return null; }
};
const toRow = (r: any): AuditRow => ({
  id: String(r.id), at: String(r.at), actorUserId: r.actor_user_id ?? null, actorEmail: r.actor_email ?? null,
  source: r.source, ip: r.ip ?? null, area: r.area, action: r.action, target: r.target ?? null,
  before: parseJson(r.before_json), after: parseJson(r.after_json), link: r.link ?? null,
});

/** One page of an org's rows, newest first; `next` resumes after its last row. */
export async function listAudit(db: DB, orgId: string, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; next: string | null }> {
  const limit = Math.min(Math.max(1, Math.floor(f.limit ?? AUDIT_PAGE_DEFAULT)), AUDIT_PAGE_MAX);
  const where: string[] = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (f.area) { where.push('area = ?'); params.push(f.area); }
  // No ESCAPE clause (pg-mem has none): '%' is dropped, and '_' - common in emails - stays a one-character
  // wildcard, which can only widen a match by a character, never miss the address typed.
  if (f.actor) { where.push('lower(actor_email) LIKE ?'); params.push(`%${f.actor.toLowerCase().replace(/%/g, '')}%`); }
  if (f.from) { where.push('at >= ?'); params.push(f.from); }
  if (f.to) { where.push('at <= ?'); params.push(f.to); }
  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  if (cursor) { where.push('(at < ? OR (at = ? AND id < ?))'); params.push(cursor[0], cursor[0], cursor[1]); }
  const rows = await db.all<any>(
    `SELECT * FROM config_audit WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ${limit + 1}`,
    params,
  );
  const page = rows.slice(0, limit).map(toRow);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > limit && last ? encodeCursor(last.at, last.id) : null };
}

/** A CSV cell: quoted when it must be, and never something a spreadsheet would run as a formula. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_CSV_HEADER = ['at', 'actor', 'source', 'ip', 'area', 'action', 'target', 'before', 'after', 'link'];

export function auditCsvLines(rows: AuditRow[]): string[] {
  return rows.map(r => [r.at, r.actorEmail, r.source, r.ip, r.area, r.action, r.target, r.before, r.after, r.link].map(csvCell).join(','));
}
