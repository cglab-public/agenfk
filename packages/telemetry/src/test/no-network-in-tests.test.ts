/**
 * Telemetry must be inert under a test runner.
 *
 * TelemetryClient's constructor used to build a real PostHog client with
 * `flushAt: 1, flushInterval: 0` — flush immediately — with no test guard. Every
 * packages/server test file imports the server, constructs one and captures
 * events, so a single `npm test` fired 24 real HTTPS requests to app.posthog.com,
 * one per file. Those sockets were the wandering `read ECONNRESET` that rolled
 * agenfk verify gates backwards for months, and they meant every developer's and
 * every CI test run shipped analytics to a third party.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TelemetryClient } from '../index';

const RUNNER_KEYS = ['VITEST', 'NODE_ENV'] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of RUNNER_KEYS) {
    if (k in saved) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  delete process.env.AGENFK_TEST_ENABLE_TELEMETRY;
});
const remember = (k: string) => { saved[k] = process.env[k]; };

describe('TelemetryClient under a test runner', () => {
  it('reports itself disabled, so nothing is ever sent', () => {
    // The suite itself runs under VITEST, so this is the live condition.
    expect(process.env.VITEST || process.env.NODE_ENV === 'test').toBeTruthy();
    expect(new TelemetryClient().isEnabled).toBe(false);
  });

  it('opens no socket when capture() is called', async () => {
    // The previous version of this spec only asserted capture() did not throw —
    // which it never could, being wrapped in try/catch since long before this
    // guard existed. It passed against unfixed code. Count connects instead.
    const { Socket } = await import('net');
    const real = Socket.prototype.connect;
    let connects = 0;
    (Socket.prototype as any).connect = function (...args: any[]) {
      connects++;
      return (real as any).apply(this, args);
    };
    try {
      new TelemetryClient().capture('test.event', { a: 1 });
      await new Promise(r => setTimeout(r, 50));
    } finally {
      Socket.prototype.connect = real;
    }
    expect(connects).toBe(0);
  });

  it('treats an explicit 0 or false as OFF, not as "enabled"', () => {
    // `!process.env.X` made AGENFK_TEST_ENABLE_TELEMETRY=0 turn telemetry ON —
    // the opposite of what anyone typing that means, silently restoring the
    // 24-requests-per-run behaviour this guard exists to stop.
    remember('VITEST');
    for (const v of ['0', 'false', '']) {
      process.env.AGENFK_TEST_ENABLE_TELEMETRY = v;
      expect(new TelemetryClient().isEnabled, v).toBe(false);
    }
  });

  it('can still be turned on deliberately, for the rare test that wants it', () => {
    // An escape hatch, so the guard is a default and not a wall.
    remember('VITEST');
    process.env.AGENFK_TEST_ENABLE_TELEMETRY = '1';
    expect(new TelemetryClient().isEnabled).toBe(true);
  });
});
