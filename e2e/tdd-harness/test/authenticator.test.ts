/**
 * The harness's software WebAuthn authenticator, checked against the server's
 * own verifier: what it produces must be exactly what a real authenticator
 * sends, or the passkey scenarios prove nothing about the real path.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM module, run by node inside the container
import { softAuthenticator } from '../driver/authenticator.mjs';
import { verifyRegistration, verifyAssertion } from '../../../packages/server/src/passkeys';

const ORIGIN = 'http://localhost:5173';

describe('softAuthenticator', () => {
  it('registers a credential the server accepts', () => {
    const a = softAuthenticator();
    const cred = verifyRegistration(a.register('chal-1'), 'chal-1', [ORIGIN]);
    expect(cred.id).toBe(a.id);
    expect(cred.alg).toBe(-7);
  });

  it('signs assertions the server verifies, with a sign count that goes up', () => {
    const a = softAuthenticator();
    const cred = { ...verifyRegistration(a.register('c0'), 'c0', [ORIGIN]), signCount: 0 };
    const first = verifyAssertion(a.assert('c1'), cred, 'c1', [ORIGIN]);
    const second = verifyAssertion(a.assert('c2'), { ...cred, signCount: first.signCount }, 'c2', [ORIGIN]);
    expect(second.signCount).toBeGreaterThan(first.signCount);
  });

  it('is refused for another challenge, another origin, or without user verification', () => {
    const a = softAuthenticator();
    const cred = { ...verifyRegistration(a.register('c0'), 'c0', [ORIGIN]), signCount: 0 };
    expect(() => verifyAssertion(a.assert('c1'), cred, 'other', [ORIGIN])).toThrow(/challenge/);
    expect(() => verifyAssertion(softAuthenticator({ origin: 'http://localhost:9999' }).assert('c1'), cred, 'c1', [ORIGIN])).toThrow(/origin/);
    const noUv = softAuthenticator({ userVerified: false });
    expect(() => verifyRegistration(noUv.register('c0'), 'c0', [ORIGIN])).toThrow(/user verification/);
  });
});
