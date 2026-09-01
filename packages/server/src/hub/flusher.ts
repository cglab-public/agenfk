import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, FlusherStatus } from './types.js';
import { PENDING_ORG } from './hubClient.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;
const HALT_AFTER_4XX_ATTEMPTS = 5;
/**
 * 4xx codes that mean "come back later", not "your request is invalid". These
 * can carry the hub's own JSON error shape (the rate limiter at
 * packages/hub/src/util/rateLimit.ts answers 429 {error: ...}) so the body-shape
 * test alone would misread them as terminal and halt on rate limiting.
 */
const RETRYABLE_4XX = new Set([408, 425, 429]);
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Where hub-rejected events are preserved before their outbox rows are
 * deleted (CGLAB-117). Same idiom as hubClient.ts's HUB_CONFIG_PATH; the CLI
 * `hub deadletter` commands duplicate this path expression (packages/cli/src/
 * commands/hub.ts deadletterFile) — the packages share no module, so rename
 * here and the CLI reader must move with it (hub-carryover-deadletter.test.ts
 * pins the literal against drift).
 */
export const DEFAULT_DEADLETTER_PATH = path.join(os.homedir(), '.agenfk', 'hub-deadletter.jsonl');

/**
 * Resolve the running agenfk version once at module load. Story 7 of
 * EPIC 541c12b3 — the value is sent on every /v1/events batch via the
 * X-Agenfk-Version header so the hub can show "currently running" alongside
 * each installation.
 */
const CURRENT_VERSION: string = (() => {
  // Walk a few candidate package.json paths — this code runs from
  // packages/server/dist/hub/flusher.js after build, so __dirname differs
  // between source-checkout and the installed tarball.
  const candidates = [
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(__dirname, '../../../cli/package.json'),
    path.resolve(__dirname, '../../../../packages/cli/package.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
    } catch { /* keep trying */ }
  }
  return '0.0.0';
})();

/**
 * Does a 4xx response body carry the hub's own JSON error shape?
 *
 * A real hub always rejects with JSON carrying a string `error` field —
 * 401 `{error: 'Invalid or revoked token'}` from packages/hub/src/auth/apiKey.ts,
 * 400/413 from packages/hub/src/routes/events.ts. A captive portal or corporate
 * proxy interposing on the connection answers HTML, or nothing at all.
 *
 * Only an authoritative rejection counts toward the halt threshold: halting on
 * a proxy's 403 used to kill delivery for the rest of the process's lifetime,
 * which is exactly what happens to a laptop off the VPN. (BUG 1843e145.)
 */
function isHubEventsAck(data: unknown): boolean {
  // POST /v1/events answers {ingested, skipped, rejected, ...} — see
  // packages/hub/src/routes/events.ts. A captive portal that answers 200 with an
  // HTML login page does not, and must never be mistaken for a delivery:
  // flushOnce deletes the batch on success, so trusting a bare 2xx destroys
  // events that never reached the hub.
  return !!data && typeof data === 'object' && typeof (data as { ingested?: unknown }).ingested === 'number';
}

function isAuthoritativeRejection(data: unknown): boolean {
  if (data && typeof data === 'object') {
    const err = (data as { error?: unknown }).error;
    return typeof err === 'string' && err.length > 0;
  }
  if (typeof data === 'string') {
    // Some transports hand back an unparsed JSON string.
    try {
      const parsed = JSON.parse(data);
      return !!parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.length > 0;
    } catch {
      return false; // HTML, plain text, empty — a proxy, not the hub
    }
  }
  return false;
}

export class Flusher {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private status: FlusherStatus;
  private http: AxiosInstance;
  private nextEligibleAt: number = 0;

  constructor(
    private storage: SQLiteStorageProvider,
    private config: HubConfig,
    private installationId: string,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
    private batchSize: number = DEFAULT_BATCH_SIZE,
    httpClient?: AxiosInstance,
    /** See DEFAULT_DEADLETTER_PATH. Injectable for tests. */
    private deadletterPath: string = DEFAULT_DEADLETTER_PATH,
  ) {
    this.http = httpClient ?? axios.create({
      baseURL: config.url,
      timeout: 15_000,
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'X-Installation-Id': installationId,
        'X-Agenfk-Version': CURRENT_VERSION,
        'Content-Type': 'application/json',
      },
    });
    this.status = {
      enabled: true,
      lastFlushAt: null,
      lastError: null,
      outboxDepth: storage.hubOutboxCount(),
      halted: false,
      consecutiveFailures: 0,
      rejectedByHub: 0,
      staleOrgDepth: 0,
      deadletterDepth: 0,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => { /* logged in flush */ }); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStatus(): FlusherStatus {
    // Stale-org depth is computed from the outbox itself, not cached: rows can
    // be appended by the request path at any time, and carry-over/discard
    // (CLI) removes them outside the flusher's knowledge.
    let staleOrgDepth = 0;
    for (const [org, n] of Object.entries(this.storage.hubOutboxOrgCounts())) {
      if (org !== this.config.orgId && org !== PENDING_ORG) staleOrgDepth += n;
    }
    return {
      ...this.status,
      outboxDepth: this.storage.hubOutboxCount(),
      staleOrgDepth,
      deadletterDepth: countJsonlLines(this.deadletterPath),
      // Surfaced so the CLI can warn about an install that is stuck WITHOUT
      // being halted — a retired hub URL answering 404 HTML now backs off
      // forever instead of halting, and would otherwise be invisible.
      nextRetryAt: this.nextEligibleAt > Date.now() ? new Date(this.nextEligibleAt).toISOString() : null,
    };
  }

  /**
   * Run a single flush cycle. If a cycle is already in flight, returns the
   * same promise (so callers like SIGTERM and the timer don't queue overlapping
   * batches).
   */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.status.halted) return this.probeRecovery();
    if (Date.now() < this.nextEligibleAt) return Promise.resolve();
    this.inflight = this.flushOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * Synchronously drain the outbox or give up after `timeoutMs`. Used by
   * Story 3b's upgradeSync to make sure a `fleet:upgrade:started` event
   * reaches the hub BEFORE the running server is killed by its own upgrade.
   *
   * Caller-resilient: never throws on transport errors. Events that fail to
   * deliver remain in the local outbox and replay on next boot.
   */
  async flushNow(timeoutMs: number = 5_000): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // A halted flusher must stay halted: zeroing the gate here used to let
    // flushNow POST a doomed batch and, worse, make the next timer tick probe
    // immediately instead of at the capped cadence.
    if (this.status.halted) return;
    // Bypass the rate-limiter — flushNow is an explicit "go now" request.
    this.nextEligibleAt = 0;
    while (Date.now() < deadline) {
      if (this.storage.hubOutboxCount() === 0) return;
      try {
        // Wait for any in-flight flush, then run one more cycle.
        if (this.inflight) {
          await this.inflight;
        } else {
          this.inflight = this.flushOnce().finally(() => { this.inflight = null; });
          await this.inflight;
        }
      } catch { /* swallowed: event stays in outbox for next attempt */ }
      // If the cycle pushed us into backoff or halted state, stop trying.
      if (this.status.halted) return;
      if (Date.now() < this.nextEligibleAt) return;
    }
  }

  /**
   * Recovery probe for a halted flusher. Without this, `halted` was terminal:
   * nothing outside the constructor ever cleared it, so an install stopped
   * delivering until someone restarted the API server. A successful
   * GET /v1/ping means whatever rejected us is gone, so resume.
   *
   * Probes at the capped backoff cadence rather than every cycle, and never
   * throws — a failed probe just leaves the flusher halted.
   */
  private async probeRecovery(): Promise<void> {
    if (Date.now() < this.nextEligibleAt) return;
    // Assigned BEFORE the await, so overlapping timer ticks cannot fire
    // concurrent probes — load-bearing, do not reorder.
    this.nextEligibleAt = Date.now() + MAX_BACKOFF_MS;
    let recovered = false;
    try {
      const { data } = await this.http.get('/v1/ping');
      // The same validation `agenfk hub repoint` performs before trusting an
      // endpoint: a captive portal answering 200 with an HTML login page is not
      // our hub, and un-halting on it would resume deleting events into it.
      if (data?.ok !== true || data?.orgId !== this.config.orgId) return;
      this.status.halted = false;
      this.status.lastError = null;
      this.status.consecutiveFailures = 0;
      this.nextEligibleAt = 0;
      recovered = true;
    } catch {
      /* still rejected — stay halted, retry after the backoff window */
    }
    // Recovering is only half the job: `agenfk hub flush` (and the timer) asked
    // for a delivery, so deliver instead of reporting a healthy no-op.
    if (recovered) {
      this.inflight = this.flushOnce().finally(() => { this.inflight = null; });
      await this.inflight;
    }
  }

  private async flushOnce(): Promise<void> {
    // The org boundary lives in the SQL window itself (CGLAB-117): rows whose
    // payload stamps a different org — or the pending sentinel — never enter
    // the batch, and stale rows at the head of the oldest-first window cannot
    // starve the deliverable ones behind them (a post-peek JS filter would
    // stall delivery forever once >=batchSize stale rows queue up ahead of
    // them — a silent stall replacing the silent loss). Shipping a
    // foreign-stamped row is exactly how the 31 Aug incident destroyed 57
    // events: rejected inside a 200, deleted with the batch. Stale rows stay
    // in the outbox awaiting an explicit `agenfk hub carry-over` or discard,
    // and surface via staleOrgDepth. Rows with no orgId field still ship (no
    // stamp, nothing to leak — the hub judges them); unparseable payloads
    // never ship: they can never deliver and would throw for the WHOLE batch
    // on the way into the POST.
    const rows = this.storage.hubOutboxPeekDeliverable(this.batchSize, this.config.orgId);
    if (rows.length === 0) {
      this.status.lastFlushAt = new Date().toISOString();
      // A cycle with nothing deliverable is not a failed attempt. Without
      // this clear, a transport hiccup from an hour ago keeps `hub flush`
      // printing red + exit 1 forever once the outbox empties (or holds only
      // stale rows awaiting carry-over) — a false alarm with no actionable
      // content, and it made the CLI's stale-row guidance unreachable.
      this.status.lastError = null;
      return;
    }
    const events = rows.map(r => JSON.parse(r.payload));
    const ids = rows.map(r => r.event_id);
    let refusedNow = 0;
    try {
      const resp = await this.http.post('/v1/events', { events });
      if (!isHubEventsAck(resp?.data)) {
        // A 2xx from something that is not the hub. Keep the batch and back off
        // rather than deleting events into a captive portal.
        throw new Error('Response was not an agenfk-hub ingest acknowledgement');
      }
      const data = resp.data as { rejected?: unknown; rejections?: unknown };
      const refused = Number(data?.rejected ?? 0);
      const rejections = Array.isArray(data?.rejections) ? (data.rejections as Array<{ eventId?: unknown; reason?: unknown }>) : null;

      if (rejections) {
        // NEW hub: per-event detail. Delete only the accepted rows; rejected
        // rows are preserved in the deadletter file FIRST, then removed from
        // the outbox — a failed write throws here, leaving the rows in place
        // for retry rather than repeating the silent loss this exists to fix.
        const reasonByEventId = new Map<string, string>();
        const batchIds = new Set(ids);
        for (const rj of rejections) {
          // Entries the hub could not attribute (eventId null — it could not
          // read one — or an id absent from this batch) cannot be mapped to a
          // row. The spoke writes its own payloads, so an unattributable entry
          // is a hub-side curiosity, not a loss to record.
          if (typeof rj?.eventId === 'string' && batchIds.has(rj.eventId)) {
            reasonByEventId.set(rj.eventId, typeof rj.reason === 'string' ? rj.reason : 'unknown');
          }
        }
        // Rows whose payload lost its usable eventId can never be attributed
        // by either side — the hub reports them with eventId null. They are
        // rejected by DEFINITION (the hub's isValidEvent requires a string
        // eventId), so they join the deadletter as 'invalid' instead of being
        // deleted silently. The spoke writes its own payloads, so a row gets
        // here only through DB corruption.
        for (const r of rows) {
          const parsedEventId = (JSON.parse(r.payload) as { eventId?: unknown }).eventId;
          if (!(typeof parsedEventId === 'string' && parsedEventId.length > 0) && !reasonByEventId.has(r.event_id)) {
            reasonByEventId.set(r.event_id, 'invalid');
          }
        }
        if (reasonByEventId.size > 0) {
          this.deadletterRows(rows.filter(r => reasonByEventId.has(r.event_id)), reasonByEventId);
          this.status.rejectedByHub += reasonByEventId.size;
          this.status.lastRejectionAt = new Date().toISOString();
          // Refusals must be as loud as transport failures: `hub flush` and
          // the preAction banner key off lastError, and a 200-with-rejections
          // that clears it would put the events' disappearance right back to
          // where 31 Aug was — invisible inside a green success.
          this.status.lastError = `hub refused ${reasonByEventId.size} event(s) in the last batch — preserved in ${this.deadletterPath}; see \`agenfk hub deadletter\``;
          refusedNow = reasonByEventId.size;
          console.warn(
            `[HUB] The hub refused ${reasonByEventId.size} event(s) from this batch; they are preserved in ${this.deadletterPath}. `
            + `${this.status.rejectedByHub} refused in total. Reasons usually mean a re-onboarded or hidden identity — `
            + 'see `agenfk hub deadletter`.',
          );
        }
        // Accepted AND rejected rows both leave the outbox here (rejected ones
        // only after the deadletter write above succeeded — it throws first).
      } else if (refused > 0) {
        // OLD hub (predates the rejections field): it refused something but
        // cannot say which events. Deleting the batch is the 31 Aug failure
        // mode again; keeping it costs nothing because hub-side INSERT OR
        // IGNORE makes re-sends idempotent. Nothing is lost yet, so
        // rejectedByHub (a lost-events counter) must NOT tick — but the kept
        // rows must age like any failed delivery: attempts climb, the cadence
        // backs off toward the cap, the warn stops being a 30s siren, and the
        // CLI banner can see the install is stuck. Halting is deliberately
        // NOT used: halt's ping-probe recovery would instantly un-halt a
        // healthy-but-old hub, so escalating the cadence is the real lever.
        this.status.lastError = `hub rejected ${refused} of ${rows.length} events (no per-event detail - upgrade hub)`;
        this.status.lastFlushAt = new Date().toISOString();
        this.status.lastRejectionAt = new Date().toISOString();
        this.status.consecutiveFailures++;
        this.storage.hubOutboxIncrementAttempt(ids, 'hub rejected events without per-event detail (old hub)');
        const maxAttempts = Math.max(...rows.map(r => r.attempts + 1));
        this.nextEligibleAt = Date.now() + this.backoffMs(maxAttempts);
        console.warn(`[HUB] ${this.status.lastError} — batch kept for retry; re-sends are idempotent.`);
        return;
      }
      this.storage.hubOutboxDelete(ids);
      this.status.lastFlushAt = new Date().toISOString();
      // Transport is healthy, but refusals this cycle keep lastError set —
      // clearing it here is what made permanent loss look like success.
      if (refusedNow === 0) this.status.lastError = null;
      this.status.consecutiveFailures = 0;
      this.nextEligibleAt = 0;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error || e?.message || 'unknown';
      this.storage.hubOutboxIncrementAttempt(ids, msg);
      this.status.lastError = `HTTP ${status ?? 'ERR'}: ${msg}`;
      this.status.consecutiveFailures++;
      const maxAttempts = Math.max(...rows.map(r => r.attempts + 1));
      const authoritative4xx = !!status && status >= 400 && status < 500
        && !RETRYABLE_4XX.has(status)
        && isAuthoritativeRejection(e?.response?.data);
      // Backoff applies either way. On the authoritative path it stops us
      // hammering the hub through the attempts that lead up to a halt; on the
      // transport path it is the whole recovery strategy.
      this.nextEligibleAt = Date.now() + this.backoffMs(maxAttempts);
      if (authoritative4xx && maxAttempts >= HALT_AFTER_4XX_ATTEMPTS) {
        this.status.halted = true;
      }
    }
  }

  /** Exponential retry cadence capped at MAX_BACKOFF_MS; shared by the
   *  transport-failure path and the old-hub keep-batch path. */
  private backoffMs(maxAttempts: number): number {
    return Math.min(MAX_BACKOFF_MS, this.intervalMs * Math.pow(2, maxAttempts));
  }

  /**
   * Append rejected rows to the deadletter file (JSONL, one line per event)
   * BEFORE their outbox rows are deleted. A write failure throws out of
   * flushOnce — the batch stays in the outbox and retries — so this path can
   * only ever duplicate a deadletter line (harmless, eventId is in it), never
   * lose one. `payload` is embedded parsed when possible, raw when not.
   */
  private deadletterRows(
    rows: Array<{ event_id: string; occurred_at: string; payload: string }>,
    reasonByEventId: Map<string, string>,
  ): void {
    const deadletteredAt = new Date().toISOString();
    const lines = rows.map(r => {
      let payload: unknown = r.payload;
      try { payload = JSON.parse(r.payload); } catch { /* keep the raw string */ }
      return JSON.stringify({
        eventId: r.event_id,
        occurredAt: r.occurred_at,
        deadletteredAt,
        // The rows passed in are exactly those keyed in the map, so get()
        // cannot miss — no fallback.
        reason: reasonByEventId.get(r.event_id)!,
        payload,
      });
    });
    fs.mkdirSync(path.dirname(this.deadletterPath), { recursive: true });
    // 0600: the lines embed actor.osUser/gitEmail and item titles — tenant
    // data, same standard as hub.json (server.ts). appendFileSync's mode
    // applies only on creation; chmod covers the pre-existing-file case.
    fs.appendFileSync(this.deadletterPath, lines.join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(this.deadletterPath, 0o600); } catch { /* best effort */ }
  }
}

/** Line count of a JSONL file; 0 when it does not exist yet. */
function countJsonlLines(filePath: string): number {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
