import axios, { AxiosInstance } from 'axios';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, FlusherStatus } from './types.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;
const HALT_AFTER_4XX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

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
