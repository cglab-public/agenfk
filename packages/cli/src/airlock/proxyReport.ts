/**
 * Airlock layer 2 (GH-294, TEL-1): the sandbox proxy's decisions (its
 * denials: see runtime.ts), reported to the AgEnFK server
 * (POST /airlock/proxy-decisions), which logs them beside the tool-call
 * decisions as source 'proxy'.
 *
 * The proxy has decided before anything is reported, and the report can never
 * change that or hold it up:
 *  - report() only queues: it returns at once and never throws;
 *  - the queue is sent in batches, every PROXY_REPORT_FLUSH_MS, each post
 *    aborted after PROXY_REPORT_TIMEOUT_MS, and a failed post is dropped (a
 *    server that is down loses the report, not the session);
 *  - a decision the server could not take (a host past ASRT's 255 characters,
 *    or outside a host's characters; a port out of range) is dropped here,
 *    not sent to cost the batch;
 *  - an identical decision within PROXY_REPORT_DEDUPE_MS is queued once, and
 *    the queue holds at most PROXY_REPORT_MAX_QUEUE, so a retry loop in the
 *    sandbox neither floods the log nor grows this process.
 */
import type { ProxyDecision } from './runtime';

export const PROXY_REPORT_FLUSH_MS = 250;
export const PROXY_REPORT_TIMEOUT_MS = 1500;
export const PROXY_REPORT_DEDUPE_MS = 10_000;
/** The server's MAX_PROXY_DECISIONS: one batch is never larger. */
export const PROXY_REPORT_MAX_QUEUE = 200;

/** A host the server's decision log takes: what ASRT names a host, at most 255 characters. */
const REPORTABLE_HOST = /^[A-Za-z0-9._:\[\]%-]{1,255}$/;
const MAX_RULE = 256;

/** Can the server log this decision as it is? */
export function isReportable(d: ProxyDecision): boolean {
  return typeof d?.host === 'string' && REPORTABLE_HOST.test(d.host)
    && (d.port === null || (Number.isInteger(d.port) && d.port >= 0 && d.port <= 65535))
    && (d.decision === 'allow' || d.decision === 'deny')
    && typeof d.rule === 'string' && d.rule.length > 0 && d.rule.length <= MAX_RULE;
}

export interface ProxyReportBody {
  client: string;
  model: string | null;
  sessionId: string | null;
  /** The launch the decisions are for: its session's card is the one its sandbox recorded. */
  launch?: string;
  decisions: Array<ProxyDecision & { ts: string }>;
}

export interface ProxyReporterOptions {
  /** Send one batch. Should honour `signal`; it is raced against the timeout either way. */
  post: (body: ProxyReportBody, signal: AbortSignal) => Promise<unknown>;
  client: string;
  model: string | null;
  sessionId: string | null;
  /** The launch nonce (the launcher's own, never the sandbox's word). */
  launch?: string;
  now?: () => number;
}

export class ProxyDecisionReporter {
  private readonly opts: ProxyReporterOptions;
  private readonly now: () => number;
  private queue: ProxyReportBody['decisions'] = [];
  private readonly lastQueued = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ProxyReporterOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  report(d: ProxyDecision): void {
    try {
      if (!isReportable(d)) return;
      const at = this.now();
      const key = JSON.stringify([d.host, d.port, d.decision, d.rule]);
      const last = this.lastQueued.get(key);
      if (last !== undefined && at - last < PROXY_REPORT_DEDUPE_MS) return;
      if (this.queue.length >= PROXY_REPORT_MAX_QUEUE) return;
      this.lastQueued.set(key, at);
      if (this.lastQueued.size > 1000) {
        for (const [k, t] of this.lastQueued) if (at - t >= PROXY_REPORT_DEDUPE_MS) this.lastQueued.delete(k);
      }
      this.queue.push({ host: d.host, port: d.port, decision: d.decision, rule: d.rule, ts: new Date(at).toISOString() });
      this.schedule();
    } catch { /* a report never fails the proxy */ }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PROXY_REPORT_FLUSH_MS);
    // A pending report never keeps the CLI alive.
    this.timer.unref?.();
  }

  /** Send what is queued. Resolves within PROXY_REPORT_TIMEOUT_MS; never rejects. */
  async flush(): Promise<void> {
    const decisions = this.queue.splice(0, PROXY_REPORT_MAX_QUEUE);
    if (!decisions.length) return;
    const body: ProxyReportBody = {
      client: this.opts.client, model: this.opts.model, sessionId: this.opts.sessionId,
      ...(this.opts.launch ? { launch: this.opts.launch } : {}),
      decisions,
    };
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timeout = setTimeout(() => { abort.abort(); resolve(); }, PROXY_REPORT_TIMEOUT_MS);
      timeout.unref?.();
    });
    const sent = Promise.resolve()
      .then(() => this.opts.post(body, abort.signal))
      .then(() => undefined, () => undefined);
    try {
      await Promise.race([sent, expired]);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The session ended: send the last batch (bounded by the timeout) and stop. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
