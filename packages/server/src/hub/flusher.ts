import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, FlusherStatus } from './types.js';
import { PENDING_ORG } from './hubClient.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;
const HALT_AFTER_4XX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

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
    return { ...this.status, outboxDepth: this.storage.hubOutboxCount() };
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
    this.nextEligibleAt = Date.now() + MAX_BACKOFF_MS;
    try {
      await this.http.get('/v1/ping');
      this.status.halted = false;
      this.status.lastError = null;
      this.nextEligibleAt = 0;
    } catch {
      /* still rejected — stay halted, retry after the backoff window */
    }
  }

  private async flushOnce(): Promise<void> {
    const allRows = this.storage.hubOutboxPeek(this.batchSize);
    // Never ship pending-org sentinel rows (orgId '') — they were queued while
    // the hub was disconnected and must be stamped with the real orgId first
    // (boot / `hub login` does that). The hub would reject them per-event
    // inside a 200 response and flushOnce would then DELETE them — silent loss.
    const rows = allRows.filter(r => {
      try { return JSON.parse(r.payload).orgId !== PENDING_ORG; } catch { return true; }
    });
    if (rows.length === 0) {
      this.status.lastFlushAt = new Date().toISOString();
      return;
    }
    const events = rows.map(r => JSON.parse(r.payload));
    const ids = rows.map(r => r.event_id);
    try {
      await this.http.post('/v1/events', { events });
      this.storage.hubOutboxDelete(ids);
      this.status.lastFlushAt = new Date().toISOString();
      this.status.lastError = null;
      this.nextEligibleAt = 0;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error || e?.message || 'unknown';
      this.storage.hubOutboxIncrementAttempt(ids, msg);
      this.status.lastError = `HTTP ${status ?? 'ERR'}: ${msg}`;
      const maxAttempts = Math.max(...rows.map(r => r.attempts + 1));
      const authoritative4xx = !!status && status >= 400 && status < 500
        && isAuthoritativeRejection(e?.response?.data);
      if (authoritative4xx) {
        if (maxAttempts >= HALT_AFTER_4XX_ATTEMPTS) {
          this.status.halted = true;
        }
      } else {
        // 5xx, network failure, or a 4xx interposed by a proxy (no hub JSON
        // error body): exponential backoff capped at MAX_BACKOFF_MS.
        const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * Math.pow(2, maxAttempts));
        this.nextEligibleAt = Date.now() + backoff;
      }
    }
  }
}
