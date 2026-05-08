/**
 * Story 3a — Flusher.flushNow() synchronous-flush primitive.
 *
 * Story 3b will call this after appending the `fleet:upgrade:started` event
 * but BEFORE spawning `agenfk upgrade` (which is going to kill this process).
 * Without flushNow, the started event sits in the local outbox and the hub
 * never sees the upgrade kicking off.
 *
 * Source-string assertions matching the convention in upgrade-tier.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SRC = readFileSync(
  path.resolve(__dirname, '../hub/flusher.ts'),
  'utf8'
);

describe('Story 3a — Flusher.flushNow() primitive', () => {
  it('declares a flushNow method on the Flusher class', () => {
    expect(SRC).toMatch(/\bflushNow\s*\(/);
  });

  it('accepts an optional timeout parameter (default ~5s)', () => {
    expect(SRC).toMatch(/flushNow\s*\(\s*timeoutMs[^)]*\)/);
  });

  it('does not throw on transport failure (caller-resilient)', () => {
    // The implementation must wrap its inner flush calls in a try/catch — we
    // assert by looking for a try block within or near the flushNow body.
    const fnIdx = SRC.search(/\bflushNow\s*\(/);
    expect(fnIdx).toBeGreaterThan(-1);
    const after = SRC.slice(fnIdx, fnIdx + 1500);
    expect(after).toMatch(/try\s*\{/);
  });

  it('drains until the outbox is empty OR timeout elapses', () => {
    const fnIdx = SRC.search(/\bflushNow\s*\(/);
    const after = SRC.slice(fnIdx, fnIdx + 1500);
    // Either an explicit hubOutboxCount() loop check, or a Date.now() / deadline guard.
    expect(after).toMatch(/hubOutboxCount\(|outboxDepth|outbox.*length|Date\.now\(\)/);
  });
});
