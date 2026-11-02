/**
 * @vitest-environment node
 *
 * SX-1 (8dd7c7c0): the launcher's proxy marks every request the sandbox sends to
 * the AgEnFK server. The marker is keyed with the Airlock report token, which the
 * sandbox cannot read, so the agent cannot mint one; the server checks it with
 * the same token and keeps no state, so a restart forgets nothing.
 */
import { describe, it, expect } from 'vitest';
import { mintAirlockSessionMarker, verifyAirlockSessionMarker, AIRLOCK_SESSION_HEADER } from '../airlock';

const KEY = 'airlock-report-token-0123456789abcdef';

describe('Airlock session marker', () => {
  it('a marker minted with the key verifies with it, and names its nonce', () => {
    const m = mintAirlockSessionMarker(KEY, 'n0nce');
    expect(m).toMatch(/^v1\.n0nce\.[0-9a-f]{64}$/);
    expect(verifyAirlockSessionMarker(KEY, m)).toBe('n0nce');
  });

  it('each launch gets its own nonce when none is given', () => {
    const a = mintAirlockSessionMarker(KEY);
    const b = mintAirlockSessionMarker(KEY);
    expect(a).not.toBe(b);
    expect(verifyAirlockSessionMarker(KEY, a)).not.toBeNull();
  });

  it('another key, a changed nonce or MAC, and malformed values do not verify', () => {
    const m = mintAirlockSessionMarker(KEY, 'n0nce');
    expect(verifyAirlockSessionMarker('another-key-0123456789abcdef', m)).toBeNull();
    expect(verifyAirlockSessionMarker(KEY, m.replace('n0nce', 'other'))).toBeNull();
    expect(verifyAirlockSessionMarker(KEY, m.slice(0, -1) + (m.endsWith('0') ? '1' : '0'))).toBeNull();
    for (const bad of ['', 'v1', 'v1.n0nce', 'v2.n0nce.' + 'a'.repeat(64), 'v1..' + 'a'.repeat(64), 'v1.n0nce.zz', undefined, null, 42, ['v1']]) {
      expect(verifyAirlockSessionMarker(KEY, bad as any), String(bad)).toBeNull();
    }
  });

  it('no key verifies nothing and mints nothing', () => {
    const m = mintAirlockSessionMarker(KEY, 'n0nce');
    expect(verifyAirlockSessionMarker('', m)).toBeNull();
    expect(verifyAirlockSessionMarker(null, m)).toBeNull();
    expect(() => mintAirlockSessionMarker('')).toThrow();
  });

  it('the header is the one the server and the proxy agree on', () => {
    expect(AIRLOCK_SESSION_HEADER).toBe('x-agenfk-airlock-session');
  });
});
