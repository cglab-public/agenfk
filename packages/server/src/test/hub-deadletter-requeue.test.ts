/**
 * #223: `agenfk hub deadletter requeue` — the server half.
 *
 * The deadletter file is the LAST copy of every event the hub refused (the
 * flusher deleted the outbox rows after writing it). Putting events back is
 * therefore ordered the opposite way to the flusher: outbox insert FIRST, the
 * deadletter rewrite SECOND. A failure between the two can only leave an event
 * in both places (the outbox insert is INSERT OR IGNORE and the hub dedups by
 * eventId); it can never leave an event in neither.
 *
 * Behaviour-based: a real SQLite outbox and a real file at an injected path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { requeueDeadletter, readDeadletterIndicator, RequeueRewriteFailed } from '../hub/deadletter';
import { Flusher } from '../hub/flusher';

function dlLine(eventId: string, opts: { reason?: string; occurredAt?: string; orgId?: string; type?: string } = {}): string {
  const occurredAt = opts.occurredAt ?? '2026-10-07T10:00:00.000Z';
  return JSON.stringify({
    eventId,
    occurredAt,
    deadletteredAt: '2026-10-07T10:00:05.000Z',
    reason: opts.reason ?? 'foreign_installation',
    payload: {
      eventId, occurredAt, orgId: opts.orgId ?? 'acme', installationId: 'inst-1',
      type: opts.type ?? 'pr.opened', actor: { osUser: 'u' }, payload: { prNumber: 2 },
    },
  });
}

describe('requeueDeadletter (#223)', () => {
  let dbPath: string;
  let dlPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    const rnd = Math.random().toString(36).slice(2);
    dbPath = path.join(os.tmpdir(), `requeue-${process.pid}-${rnd}.sqlite`);
    dlPath = path.join(os.tmpdir(), `requeue-${process.pid}-${rnd}-deadletter.jsonl`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
    fs.rmSync(dlPath, { force: true, recursive: true });
  });

  const seed = (...lines: string[]) => fs.writeFileSync(dlPath, lines.join('\n') + '\n', { mode: 0o600 });

  it('moves the selected lines into the outbox with their original eventId, occurredAt and payload', () => {
    const l = dlLine('e1', { occurredAt: '2026-10-06T22:37:09.924Z' });
    seed(l);
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.requeued).toBe(1);
    expect(r.alreadyQueued).toBe(0);
    expect(r.remaining).toBe(0);
    expect(r.eventIds).toEqual(['e1']);
    const [row] = storage.hubOutboxPeek();
    expect(row.event_id).toBe('e1');
    expect(row.occurred_at).toBe('2026-10-06T22:37:09.924Z');
    expect(JSON.parse(row.payload)).toEqual(JSON.parse(l).payload);
    // Emptied file is removed, so the sticky indicator clears.
    expect(fs.existsSync(dlPath)).toBe(false);
  });

  it('keeps unselected and unparseable lines byte for byte, in order', () => {
    const hidden = dlLine('h', { reason: 'hidden_user' });
    seed(hidden, 'TORN-LINE', dlLine('fi'), dlLine('om', { reason: 'org_mismatch' }));
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.requeued).toBe(1);
    expect(r.remaining).toBe(3);
    expect(r.excluded).toEqual({ 'reason:hidden_user': 1, unparseable: 1, 'reason:org_mismatch': 1 });
    expect(fs.readFileSync(dlPath, 'utf8')).toBe([hidden, 'TORN-LINE', dlLine('om', { reason: 'org_mismatch' })].join('\n') + '\n');
  });

  it('a dry run reports the selection and changes nothing', () => {
    seed(dlLine('a'), dlLine('b', { type: 'item.closed' }));
    const before = fs.readFileSync(dlPath, 'utf8');
    const r = requeueDeadletter({ storage, path: dlPath, filters: {}, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.requeued).toBe(0);
    expect(r.summary.count).toBe(2);
    expect(r.summary.byType).toEqual({ 'pr.opened': 1, 'item.closed': 1 });
    expect(r.eventIds).toEqual(['a', 'b']);
    expect(storage.hubOutboxCount()).toBe(0);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe(before);
  });

  it('applies the filters', () => {
    seed(dlLine('a', { type: 'pr.opened' }), dlLine('b', { type: 'item.closed' }));
    const r = requeueDeadletter({ storage, path: dlPath, filters: { types: ['pr.opened'] } });
    expect(r.eventIds).toEqual(['a']);
    expect(storage.hubOutboxPeek().map(x => x.event_id)).toEqual(['a']);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe(dlLine('b', { type: 'item.closed' }) + '\n');
  });

  it('a missing file is an empty selection, not an error', () => {
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.summary.count).toBe(0);
    expect(r.requeued).toBe(0);
    expect(fs.existsSync(dlPath)).toBe(false);
  });

  it('ORDER: when the deadletter rewrite fails, the events are already in the outbox and still in the file', () => {
    const raw = [dlLine('a'), dlLine('b')].join('\n') + '\n';
    fs.writeFileSync(dlPath, raw);
    let thrown: unknown;
    try {
      requeueDeadletter({
        storage, path: dlPath, filters: {},
        writeFile: () => { throw new Error('EPERM: simulated'); },
        removeFile: () => { throw new Error('EPERM: simulated'); },
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RequeueRewriteFailed);
    expect((thrown as RequeueRewriteFailed).inserted).toBe(2);
    // Duplicated, never lost.
    expect(storage.hubOutboxPeek().map(x => x.event_id).sort()).toEqual(['a', 'b']);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe(raw);

    // A re-run after the failure finishes the job without duplicating rows.
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.requeued).toBe(0);
    expect(r.alreadyQueued).toBe(2);
    expect(storage.hubOutboxCount()).toBe(2);
    expect(fs.existsSync(dlPath)).toBe(false);
  });

  it('ORDER: when the outbox insert fails, neither side changes', () => {
    const raw = dlLine('a') + '\n';
    fs.writeFileSync(dlPath, raw);
    const failing = Object.create(storage) as SQLiteStorageProvider;
    (failing as any).hubOutboxAppendMany = () => { throw new Error('SQLITE_FULL: simulated'); };
    expect(() => requeueDeadletter({ storage: failing, path: dlPath, filters: {} })).toThrow(/SQLITE_FULL/);
    expect(storage.hubOutboxCount()).toBe(0);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe(raw);
  });

  it('a partial rewrite uses the injected writer with the kept lines', () => {
    seed(dlLine('a'), dlLine('h', { reason: 'hidden_user' }));
    const writes: Array<[string, string]> = [];
    requeueDeadletter({ storage, path: dlPath, filters: {}, writeFile: (f, d) => { writes.push([f, d]); } });
    expect(writes).toEqual([[dlPath, dlLine('h', { reason: 'hidden_user' }) + '\n']]);
  });

  it.skipIf(process.platform === 'win32')('a partial rewrite keeps the file private (0600)', () => {
    seed(dlLine('a'), dlLine('h', { reason: 'hidden_user' }));
    requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(fs.statSync(dlPath).mode & 0o777).toBe(0o600);
  });

  it('onlyEventIds limits the run to the confirmed events; later refusals wait for the next run', () => {
    seed(dlLine('confirmed'), dlLine('arrived-during-prompt'));
    const r = requeueDeadletter({ storage, path: dlPath, filters: {}, onlyEventIds: ['confirmed', 'already-gone'] });
    expect(r.eventIds).toEqual(['confirmed']);
    expect(r.requeued).toBe(1);
    expect(r.excluded).toEqual({ unconfirmed: 1 });
    expect(storage.hubOutboxPeek().map(x => x.event_id)).toEqual(['confirmed']);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe(dlLine('arrived-during-prompt') + '\n');
  });

  it('a CRLF file keeps every unselected line, minus its CR', () => {
    const hidden = dlLine('h', { reason: 'hidden_user' });
    fs.writeFileSync(dlPath, [dlLine('a'), hidden, 'TORN'].join('\r\n') + '\r\n');
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.requeued).toBe(1);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe([hidden, 'TORN'].join('\n') + '\n');
  });

  // The interleaving the ordering argument rests on: a requeue landing while a
  // flush is awaiting the hub. The flush deletes only the rows it peeked, and
  // its refusals are appended after the requeue's rewrite — nothing is lost.
  it('a requeue during an in-flight flush loses neither the flushed batch nor the requeued events', async () => {
    storage.hubOutboxAppend('live', '2026-10-14T10:00:00.000Z', JSON.stringify({ eventId: 'live', orgId: 'acme', installationId: 'inst-1', type: 'item.created' }));
    let respond!: (v: any) => void;
    const http: any = { post: () => new Promise(r => { respond = r; }) };
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'acme' }, 'inst-1', 60_000, 500, http, dlPath);
    const inFlight = flusher.flush();
    await new Promise(r => setImmediate(r));

    seed(dlLine('old-1'), dlLine('old-2'));
    expect(requeueDeadletter({ storage, path: dlPath, filters: {} }).requeued).toBe(2);

    respond({ status: 200, data: { ingested: 0, skipped: 0, rejected: 1, hiddenDropped: 0, rejections: [{ eventId: 'live', reason: 'foreign_installation' }] } });
    await inFlight;

    expect(storage.hubOutboxPeek().map(x => x.event_id).sort()).toEqual(['old-1', 'old-2']);
    const dl = fs.readFileSync(dlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l).eventId);
    expect(dl).toEqual(['live']);
  });

  it('requeueing a line for the very event in flight keeps exactly one copy of it', async () => {
    const payload = JSON.parse(dlLine('x')).payload;
    storage.hubOutboxAppend('x', payload.occurredAt, JSON.stringify(payload));
    let respond!: (v: any) => void;
    const http: any = { post: () => new Promise(r => { respond = r; }) };
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'acme' }, 'inst-1', 60_000, 500, http, dlPath);
    const inFlight = flusher.flush();
    await new Promise(r => setImmediate(r));

    seed(dlLine('x'));
    const r = requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(r.requeued).toBe(0);
    expect(r.alreadyQueued).toBe(1);

    respond({ status: 200, data: { ingested: 0, skipped: 0, rejected: 1, hiddenDropped: 0, rejections: [{ eventId: 'x', reason: 'foreign_installation' }] } });
    await inFlight;
    expect(storage.hubOutboxCount()).toBe(0);
    expect(fs.readFileSync(dlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l).eventId)).toEqual(['x']);
  });

  it('the flusher reports the same deadletter count as the indicator (blank lines are not lines)', () => {
    fs.writeFileSync(dlPath, `${dlLine('a')}\n   \n${dlLine('b')}\n`);
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'acme' }, 'inst-1', 60_000, 500, {} as any, dlPath);
    expect(flusher.getStatus().deadletterDepth).toBe(2);
    expect(readDeadletterIndicator(dlPath).count).toBe(2);
  });

  it('events the hub refuses AGAIN go back to the deadletter, with no retry loop', async () => {
    seed(dlLine('a'), dlLine('b'));
    requeueDeadletter({ storage, path: dlPath, filters: {} });
    expect(fs.existsSync(dlPath)).toBe(false);

    let posts = 0;
    const http: any = {
      post: async (_url: string, body: any) => {
        posts++;
        return {
          status: 200,
          data: {
            ingested: 0, skipped: 0, rejected: body.events.length, hiddenDropped: 0,
            rejections: body.events.map((e: any) => ({ eventId: e.eventId, reason: 'foreign_installation' })),
          },
        };
      },
    };
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'acme' }, 'inst-1', 60_000, 500, http, dlPath);
    await flusher.flush();
    await flusher.flush();
    expect(posts).toBe(1);
    expect(storage.hubOutboxCount()).toBe(0);
    expect(flusher.getStatus().consecutiveFailures).toBe(0);
    const back = fs.readFileSync(dlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l).eventId).sort();
    expect(back).toEqual(['a', 'b']);
  });
});

describe('readDeadletterIndicator (#223)', () => {
  let dlPath: string;
  beforeEach(() => { dlPath = path.join(os.tmpdir(), `indicator-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`); });
  afterEach(() => { fs.rmSync(dlPath, { force: true }); });

  it('is empty when the file does not exist', () => {
    expect(readDeadletterIndicator(dlPath)).toEqual({ count: 0, actionable: 0, since: null, reasons: {}, unparseable: 0 });
  });

  it('reflects the file, and follows it when it changes', () => {
    fs.writeFileSync(dlPath, dlLine('a') + '\n');
    expect(readDeadletterIndicator(dlPath)).toMatchObject({ count: 1, actionable: 1, since: '2026-10-07T10:00:05.000Z' });
    fs.appendFileSync(dlPath, dlLine('h', { reason: 'hidden_user' }) + '\n');
    expect(readDeadletterIndicator(dlPath)).toMatchObject({ count: 2, actionable: 1, reasons: { foreign_installation: 1, hidden_user: 1 } });
    fs.rmSync(dlPath);
    expect(readDeadletterIndicator(dlPath).count).toBe(0);
  });
});
