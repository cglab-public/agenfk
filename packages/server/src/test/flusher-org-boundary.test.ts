/**
 * Story c3f4572b (CGLAB-117, epic a3690599): flusher org-boundary skip +
 * deadletter instead of silent delete.
 *
 * The 31 Aug 2026 incident: a clobbered fixture hub.json re-stamped the spoke's
 * credentials to another org; the flusher shipped 57 org-A events under org-B
 * credentials, the hub rejected every one inside a 200, and the flusher —
 * which deleted the batch on any 200 — destroyed them. 56/57 came back only
 * through WAL forensics.
 *
 * The spoke-side invariants pinned here:
 *  (a) rows whose payload orgId differs from the current config org are NEVER
 *      included in a POST batch (they are 100% doomed under current
 *      credentials); they stay in the outbox and surface via staleOrgDepth.
 *      SECURITY INVARIANT: events stamped org A must never be delivered under
 *      org B credentials.
 *  (b) on an ack with per-event rejections: delete only the accepted rows;
 *      rejected rows are appended to the deadletter file as
 *      {eventId, occurredAt, deadletteredAt, reason, payload} and removed from
 *      the outbox.
 *  (c) old hub (no rejections field) + rejected>0: delete nothing, set a loud
 *      lastError; rows retry (hub-side INSERT OR IGNORE makes re-sends
 *      idempotent).
 *
 * Behaviour-based, like the other flusher suites: a real Flusher over a real
 * SQLite outbox with an injected mock transport; assertions on observable
 * state (outbox contents, mock POST bodies, deadletter file, FlusherStatus).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { Flusher, DEFAULT_DEADLETTER_PATH } from '../hub/flusher';

const HUB_CONFIG = { url: 'http://hub.test', token: 't', orgId: 'acme' };

/** Mock transport. `postImpl` drives POST /v1/events; defaults to a NEW-HUB ack. */
function makeHttp(opts: { postImpl?: (body: any) => Promise<any> } = {}) {
  const posted: Array<{ url: string; body: any }> = [];
  const http: any = {
    post: async (url: string, body: any) => {
      posted.push({ url, body });
      if (opts.postImpl) return opts.postImpl(body);
      return { status: 200, data: { ingested: body?.events?.length ?? 0, skipped: 0, rejected: 0, hiddenDropped: 0, rejections: [] } };
    },
  };
  return { http, posted };
}

describe('Flusher org boundary + deadletter (CGLAB-117)', () => {
  let dbPath: string;
  let dlPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    const rnd = Math.random().toString(36).slice(2);
    dbPath = path.join(os.tmpdir(), `flusher-org-${process.pid}-${rnd}.sqlite`);
    dlPath = path.join(os.tmpdir(), `flusher-org-${process.pid}-${rnd}-deadletter.jsonl`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(dlPath)) fs.unlinkSync(dlPath);
  });

  /** Queue one outbox row exactly as the spoke writes it (payload eventId === row id). */
  function queue(eventId: string, orgId: string): void {
    const occurredAt = new Date().toISOString();
    storage.hubOutboxAppend(eventId, occurredAt, JSON.stringify({
      eventId,
      installationId: 'inst-1',
      orgId,
      occurredAt,
      type: 'item.created',
      actor: { osUser: 'alice', gitEmail: 'alice@example.com' },
      payload: { title: eventId },
    }));
  }

  function makeFlusher(http: any): Flusher {
    return new Flusher(storage, HUB_CONFIG, 'inst-1', 60_000, 500, http, dlPath);
  }

  function readDeadletter(): any[] {
    if (!fs.existsSync(dlPath)) return [];
    return fs.readFileSync(dlPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('SECURITY INVARIANT: never POSTs rows stamped with another org — org-A events cannot ride org-B credentials', async () => {
    // The 31 Aug scenario: re-onboarded to org B while org-A rows sit in the
    // outbox. The batch must not contain a single org-A event.
    queue('a-1', 'old-corp');
    queue('a-2', 'old-corp');
    queue('a-3', 'old-corp');
    const { http, posted } = makeHttp();
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(posted).toHaveLength(0); // nothing deliverable -> no POST at all
    expect(storage.hubOutboxCount()).toBe(3); // and nothing was deleted
    expect(flusher.getStatus().staleOrgDepth).toBe(3);
  });

  it('mixed outbox: POST carries only current-org rows; stale rows stay, current rows delete on ack', async () => {
    queue('keep-1', 'acme');
    queue('stale-1', 'old-corp');
    queue('keep-2', 'acme');
    queue('stale-2', 'other-corp');
    const { http, posted } = makeHttp();
    const flusher = makeFlusher(http);
    // BEFORE the flush, with current-org rows still in the outbox: only the
    // foreign-org rows count as stale (kills the mutant that treats the config
    // org itself as stale once the accepted rows have been deleted).
    expect(flusher.getStatus().staleOrgDepth).toBe(2);
    await flusher.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('/v1/events');
    const sentOrgs = posted[0].body.events.map((e: any) => e.orgId);
    expect(sentOrgs).toEqual(['acme', 'acme']);
    const remaining = storage.hubOutboxPeek(100).map(r => r.event_id).sort();
    expect(remaining).toEqual(['stale-1', 'stale-2']);
    const st = flusher.getStatus();
    expect(st.staleOrgDepth).toBe(2);
    expect(st.outboxDepth).toBe(2);
    // A clean new-hub ack (rejections: []) must NOT look like a rejection.
    expect(st.lastRejectionAt).toBeFalsy();
  });

  it('per-event rejections: accepted rows delete, rejected rows go to the deadletter file with reason', async () => {
    queue('ok-1', 'acme');
    queue('bad-1', 'acme');
    queue('bad-2', 'acme'); // two rejects in ONE batch: pins the multi-line JSONL join
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: {
          ingested: 1, skipped: 0, rejected: 2, hiddenDropped: 0,
          rejections: [
            { eventId: 'bad-1', reason: 'foreign_installation' },
            { eventId: 'bad-2', reason: 'invalid' },
          ],
        },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();

    // Accepted row gone from the outbox; rejected rows gone from the outbox too
    // — but only AFTER being written to the deadletter file.
    expect(storage.hubOutboxCount()).toBe(0);
    const dl = readDeadletter();
    expect(dl).toHaveLength(2);
    // Order within one flush follows outbox peek order, which is unstable for
    // equal occurred_at timestamps — assert by eventId, not position.
    const byId = Object.fromEntries(dl.map(d => [d.eventId, d]));
    expect(byId['bad-1'].reason).toBe('foreign_installation');
    expect(typeof byId['bad-1'].occurredAt).toBe('string');
    expect(byId['bad-1'].deadletteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byId['bad-1'].payload.eventId).toBe('bad-1');
    expect(byId['bad-2'].reason).toBe('invalid');
    const status = flusher.getStatus();
    expect(status.rejectedByHub).toBe(2);
    expect(status.lastRejectionAt).toBeTruthy();
    expect(status.deadletterDepth).toBe(2);
    // The warn must actually point the operator at the preserved file.
    const warnText = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(warnText).toContain(dlPath);
    expect(warnText).toContain('refused in total');
    expect(warnText).toContain('agenfk hub deadletter');
    warn.mockRestore();
  });

  it('a 2xx that is not a hub ack keeps the batch and says so in lastError', async () => {
    // Captive portal answering 200 + HTML: deleting on it would destroy the
    // batch into a non-hub. The error text is the operator's only diagnosis.
    queue('cp-1', 'acme');
    const { http } = makeHttp({ postImpl: async () => ({ status: 200, data: '<html>login</html>' }) });
    const flusher = makeFlusher(http);
    await flusher.flush();
    expect(storage.hubOutboxCount()).toBe(1);
    expect(flusher.getStatus().lastError).toContain('not an agenfk-hub ingest acknowledgement');
  });

  it('hidden_user rejections are deadlettered too — audit beats silence', async () => {
    queue('h-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: {
          ingested: 0, skipped: 0, rejected: 0, hiddenDropped: 1,
          rejections: [{ eventId: 'h-1', reason: 'hidden_user' }],
        },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(storage.hubOutboxCount()).toBe(0);
    const dl = readDeadletter();
    expect(dl).toHaveLength(1);
    expect(dl[0].eventId).toBe('h-1');
    expect(dl[0].reason).toBe('hidden_user');
  });

  it('deadletter accumulates across flushes (append, one JSONL line per event)', async () => {
    queue('r-1', 'acme');
    let call = 0;
    const { http } = makeHttp({
      postImpl: async () => {
        call++;
        return call === 1
          ? { status: 200, data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'r-1', reason: 'invalid' }] } }
          : { status: 200, data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'r-2', reason: 'invalid' }] } };
      },
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    queue('r-2', 'acme');
    await flusher.flush();

    const dl = readDeadletter();
    expect(dl).toHaveLength(2);
    expect(dl.map(d => d.eventId)).toEqual(['r-1', 'r-2']);
    expect(flusher.getStatus().deadletterDepth).toBe(2);
  });

  it('OLD hub (no rejections field) + rejected>0: delete NOTHING, loud lastError, rows retry with escalating cadence', async () => {
    queue('x-1', 'acme');
    queue('x-2', 'acme');
    // Uneven attempt counts: the escalation must key off the MOST-tried row
    // (max, not min) and the next attempt number (attempts+1, not -1), so the
    // cadence math is observable rather than hidden behind equal rows.
    storage.hubOutboxIncrementAttempt(['x-1'], 'pre');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { http, posted } = makeHttp({
      postImpl: async () => ({ status: 200, data: { ingested: 0, skipped: 0, rejected: 2 } }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(storage.hubOutboxCount()).toBe(2); // batch kept — the old silent-delete destroyed it
    expect(flusher.getStatus().lastError)
      .toBe('hub rejected 2 of 2 events (no per-event detail - upgrade hub)');
    // Nothing was actually lost (rows remain), so the lost-events counter must
    // not tick — it counts refused-and-gone, not refused-and-retrying.
    expect(flusher.getStatus().rejectedByHub).toBe(0);
    // But the kept rows age like any failed delivery: attempts climb (visible
    // in the DB with the old-hub reason), the banner counter moves, the
    // rejection is timestamped, and the cadence escalates off the max-attempt
    // row: max(1,0)+1 = 2 -> intervalMs * 2^2 = 240s (not min->120s, not
    // attempts-1 -> 60s, not divide -> 15s).
    const rows = storage.hubOutboxPeek(10).sort((a, b) => a.event_id.localeCompare(b.event_id));
    expect(rows.map(r => r.attempts)).toEqual([2, 1]);
    expect(rows[0].last_error).toContain('old hub');
    expect(flusher.getStatus().consecutiveFailures).toBe(1);
    expect(flusher.getStatus().lastRejectionAt).toBeTruthy();
    const retryAt = new Date(flusher.getStatus().nextRetryAt!).getTime() - Date.now();
    expect(retryAt).toBeGreaterThan(180_000);
    expect(retryAt).toBeLessThan(300_000);
    expect(readDeadletter()).toHaveLength(0);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('batch kept for retry');
    warn.mockRestore();

    // And the rows DO retry (idempotent hub-side via INSERT OR IGNORE).
    // flushNow bypasses the escalating backoff, so the retry itself — not the
    // rate limiter — is what this asserts.
    await flusher.flushNow(1_000);
    expect(posted).toHaveLength(2);
  });

  it('OLD hub clean ack (rejected=0, no rejections field) still deletes the batch', async () => {
    queue('c-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({ status: 200, data: { ingested: 1, skipped: 0, rejected: 0 } }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    expect(storage.hubOutboxCount()).toBe(0);
    expect(flusher.getStatus().lastError).toBeNull();
  });

  it('review F2: a modern-hub cycle WITH refusals leaves lastError set — 200-with-rejections must not read as clean', async () => {
    queue('r-1', 'acme');
    queue('r-2', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: {
          ingested: 1, skipped: 0, rejected: 1, hiddenDropped: 0,
          rejections: [{ eventId: 'r-2', reason: 'org_mismatch' }],
        },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    const st = flusher.getStatus();
    expect(st.rejectedByHub).toBe(1);
    // The exact invisibility 31 Aug had: refused events inside a green ack.
    expect(st.lastError).toMatch(/hub refused 1 event/);
    expect(st.lastError).toMatch(/agenfk hub deadletter/);
  });

  it('review F1: a no-op cycle clears a stale lastError — flush must not stay red forever', async () => {
    queue('s-1', 'acme');
    const { http } = makeHttp({ postImpl: async () => { throw new Error('ECONNREFUSED'); } });
    const flusher = makeFlusher(http);
    await flusher.flush();
    expect(flusher.getStatus().lastError).toContain('ECONNREFUSED');
    // Rows leave by some other route (carry-over + flush, or discard). The
    // next cycle has nothing deliverable: it is NOT a failed attempt, so the
    // historical error must not keep `hub flush` exiting 1 forever.
    storage.hubOutboxDelete(['s-1']);
    (flusher as any).nextEligibleAt = 0; // bypass the transport backoff
    await flusher.flush();
    expect(flusher.getStatus().lastError).toBeNull();
  });

  it('rejection entries that cannot be attributed to a batch row are ignored (no crash, no false deadletter)', async () => {
    // A null entry, an eventId the hub could not read (null), and an id absent
    // from this batch: none can be mapped to a row. The spoke wrote these
    // payloads itself, so an unattributable rejection is a hub-side curiosity,
    // not a loss to record. The rows stay accepted — and the lost-events
    // counter must NOT tick for entries that were never ours to lose.
    queue('p-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 1, skipped: 0, rejected: 3, rejections: [null, { eventId: null, reason: 'invalid' }, { eventId: 'not-in-batch', reason: 'org_mismatch' }] },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(storage.hubOutboxCount()).toBe(0); // accepted path (delete) — nothing to attribute
    expect(readDeadletter()).toHaveLength(0);
    expect(flusher.getStatus().rejectedByHub).toBe(0);
  });

  it('a rejection with a non-string reason is deadlettered with reason "unknown"', async () => {
    queue('u-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'u-1', reason: 42 }] },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    const dl = readDeadletter();
    expect(dl).toHaveLength(1);
    expect(dl[0].reason).toBe('unknown');
  });

  it('an unparseable payload row never ships and never poisons the batch', async () => {
    // The spoke writes its own payloads, so an unparseable row is corruption:
    // it can never deliver (the hub's isValidEvent would reject it) and must
    // not take the healthy rows down with it — JSON.parse on the way into the
    // POST used to throw for the WHOLE batch.
    storage.hubOutboxAppend('rot-1', new Date().toISOString(), 'NOT-JSON');
    queue('fine-1', 'acme');
    const { http, posted } = makeHttp();
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0].body.events.map((e: any) => e.eventId)).toEqual(['fine-1']);
    const remaining = storage.hubOutboxPeek(10).map(r => r.event_id);
    expect(remaining).toEqual(['rot-1']); // kept — undeliverable, awaiting discard (story 3's deadletter command)
  });

  it('stale rows at the head of the outbox cannot starve deliverable ones', async () => {
    // The 31 Aug shape scaled up: >=batchSize stale rows older than the fresh
    // ones. A post-peek JS filter would peek the same 500 stale rows forever
    // and never reach the fresh ones; the SQL window must skip past them.
    for (let i = 0; i < 500; i++) queue(`stale-${i}`, 'old-corp');
    queue('fresh-1', 'acme');
    const { http, posted } = makeHttp();
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0].body.events.map((e: any) => e.eventId)).toEqual(['fresh-1']);
    expect(storage.hubOutboxCount()).toBe(500); // fresh delivered, stale all kept
    expect(flusher.getStatus().staleOrgDepth).toBe(500);
  });

  it('a row whose payload lost its eventId is deadlettered as invalid, not silently deleted', async () => {
    // The hub reports such rows with eventId null — neither side can attribute
    // them — and they are rejected by definition (isValidEvent requires a
    // non-empty string eventId). Deleting them silently is the 31 Aug failure
    // mode in miniature; they must land in the deadletter under the outbox
    // row id. The third row pins that an ATTRIBUTED rejection is never
    // overwritten by the unusable-id sweep (a hub that echoes back an id the
    // payload does not carry must not flip its reason to 'invalid').
    storage.hubOutboxAppend('corrupt-1', new Date().toISOString(),
      JSON.stringify({ orgId: 'acme', type: 'item.created', actor: { osUser: 'a' }, payload: {} }));
    storage.hubOutboxAppend('corrupt-2', new Date().toISOString(),
      JSON.stringify({ eventId: '', orgId: 'acme', type: 'item.created', actor: { osUser: 'a' }, payload: {} }));
    storage.hubOutboxAppend('attr-1', new Date().toISOString(),
      JSON.stringify({ orgId: 'acme', type: 'item.created', actor: { osUser: 'a' }, payload: {} }));
    queue('good-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 1, skipped: 0, rejected: 3, rejections: [
          { eventId: null, reason: 'invalid' },
          { eventId: null, reason: 'invalid' },
          { eventId: 'attr-1', reason: 'org_mismatch' },
        ] },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();

    expect(storage.hubOutboxCount()).toBe(0);
    const byId = Object.fromEntries(readDeadletter().map(d => [d.eventId, d]));
    expect(byId['corrupt-1'].reason).toBe('invalid');
    expect(byId['corrupt-2'].reason).toBe('invalid');
    expect(byId['attr-1'].reason).toBe('org_mismatch'); // attributed reason wins
    expect(byId['good-1']).toBeUndefined();
    expect(flusher.getStatus().rejectedByHub).toBe(3);
  });

  it('a deadletter write failure keeps the rows in the outbox (never silent loss)', async () => {
    // Deadletter-before-delete is the whole point: if the write throws, the
    // batch must survive for retry rather than being deleted unrecorded.
    const blocked = path.join(os.tmpdir(), `dl-blocked-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(blocked, { recursive: true }); // a DIRECTORY where the file must be -> EISDIR
    queue('keep-me-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'keep-me-1', reason: 'invalid' }] },
      }),
    });
    const flusher = new Flusher(storage, HUB_CONFIG, 'inst-1', 60_000, 500, http, blocked);
    await flusher.flush();
    expect(storage.hubOutboxCount()).toBe(1); // kept for retry, not deleted unrecorded
    fs.rmSync(blocked, { recursive: true, force: true });
  });

  it('the deadletter file is 0600 — it embeds actor identities and titles', async () => {
    queue('m-1', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'm-1', reason: 'hidden_user' }] },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    expect(fs.statSync(dlPath).mode & 0o777).toBe(0o600);
  });

  it('a pre-existing deadletter file is tightened to 0600 on write', async () => {
    // Creation mode only applies to new files; the chmod covers a file that
    // predates this code (or was created by a stryker mutant of the mode
    // option) and was left world-readable.
    fs.writeFileSync(dlPath, 'pre-existing\n', { mode: 0o644 });
    expect(fs.statSync(dlPath).mode & 0o777).toBe(0o644);
    queue('m-2', 'acme');
    const { http } = makeHttp({
      postImpl: async () => ({
        status: 200,
        data: { ingested: 0, skipped: 0, rejected: 1, rejections: [{ eventId: 'm-2', reason: 'invalid' }] },
      }),
    });
    const flusher = makeFlusher(http);
    await flusher.flush();
    expect(fs.statSync(dlPath).mode & 0o777).toBe(0o600);
  });

  it('hubOutboxPeekDeliverable refuses an empty orgId rather than aiming at the pending sentinel', async () => {
    expect(() => storage.hubOutboxPeekDeliverable(500, '')).toThrow(/non-empty string/);
    expect(() => storage.hubOutboxPeekDeliverable(500, undefined as any)).toThrow(/non-empty string/);
  });

  it('DEFAULT_DEADLETTER_PATH is the ~/.agenfk/hub-deadletter.jsonl contract the CLI reads', async () => {
    expect(DEFAULT_DEADLETTER_PATH).toBe(path.join(os.homedir(), '.agenfk', 'hub-deadletter.jsonl'));
  });

  it('staleOrgDepth excludes the PENDING_ORG sentinel rows', async () => {
    queue('pend-1', ''); // queued while disconnected — stamped by boot/login, not stale
    queue('stale-1', 'old-corp');
    const { http } = makeHttp();
    const flusher = makeFlusher(http);
    const status = flusher.getStatus();
    expect(status.staleOrgDepth).toBe(1);
    expect(status.outboxDepth).toBe(2);
    expect(status.deadletterDepth).toBe(0); // no file yet -> 0, not undefined
  });

  it('hubOutboxOrgCounts(): per-org row counts, sentinel included, unparseable payloads excluded', async () => {
    queue('q-1', 'acme');
    queue('q-2', 'acme');
    queue('q-3', 'old-corp');
    queue('q-4', '');
    storage.hubOutboxAppend('q-5', new Date().toISOString(), 'NOT-JSON');
    storage.hubOutboxAppend('q-6', new Date().toISOString(), JSON.stringify({ type: 'no-org-field' }));
    const counts = storage.hubOutboxOrgCounts();
    expect(counts).toEqual({ acme: 2, 'old-corp': 1, '': 1 });
  });
});
