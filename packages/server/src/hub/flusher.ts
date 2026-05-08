import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, FlusherStatus } from './types.js';

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
    if (this.status.halted) return Promise.resolve();
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

  private async flushOnce(): Promise<void> {
    const rows = this.storage.hubOutboxPeek(this.batchSize);
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
      if (status && status >= 400 && status < 500) {
        const maxAttempts = Math.max(...rows.map(r => r.attempts + 1));
        if (maxAttempts >= HALT_AFTER_4XX_ATTEMPTS) {
          this.status.halted = true;
        }
      } else {
        // 5xx / network: exponential backoff capped at MAX_BACKOFF_MS.
        const maxAttempts = Math.max(...rows.map(r => r.attempts + 1));
        const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * Math.pow(2, maxAttempts));
        this.nextEligibleAt = Date.now() + backoff;
      }
    }
  }
}
