/**
 * @file CGLAB-383 (S7-T1) — WebAuthn checks for a passkey on the board.
 *
 * The server verifies what the browser hands it without any attestation:
 * the credential's public key (SPKI, from getPublicKey()), the authenticator
 * data (the rpId hash, user presence and user verification, the sign count),
 * and clientDataJSON (type, challenge, origin). An assertion is a signature
 * over authenticatorData || sha256(clientDataJSON) with that key. Anything
 * short of all of it is refused, with a reason.
 */
import { describe, it, expect } from 'vitest';
import { verifyRegistration, verifyAssertion } from '../passkeys';
import { SoftAuthenticator } from './softAuthenticator';

const CH = 'challenge-abc';

describe('verifyRegistration', () => {
  it('accepts an ES256 passkey created on localhost with user verification', () => {
    const a = new SoftAuthenticator();
    const cred = verifyRegistration(a.register(CH), CH);
    expect(cred).toMatchObject({ id: a.id, alg: -7 });
    expect(typeof cred.publicKey).toBe('string');
  });

  it('accepts RS256', () => {
    const a = new SoftAuthenticator(-257);
    expect(verifyRegistration(a.register(CH), CH).alg).toBe(-257);
  });

  it.each([
    ['another challenge', (a: SoftAuthenticator) => a.register('other'), /challenge/],
    ['an assertion instead of a creation', (a: SoftAuthenticator) => a.register(CH, { type: 'webauthn.get' }), /type/],
    ['a foreign origin', (a: SoftAuthenticator) => a.register(CH, { origin: 'http://evil.example' }), /origin/],
    ['an IP origin', (a: SoftAuthenticator) => a.register(CH, { origin: 'http://127.0.0.1:3000' }), /origin/],
    ['another relying party', (a: SoftAuthenticator) => a.register(CH, { rpId: 'evil.example' }), /relying party|rpId/i],
    ['no user verification', (a: SoftAuthenticator) => a.register(CH, { uv: false }), /verif/],
  ])('refuses %s', (_, make, why) => {
    expect(() => verifyRegistration(make(new SoftAuthenticator()), CH)).toThrow(why);
  });

  it('refuses a public key that is not one', () => {
    const reg = { ...new SoftAuthenticator().register(CH), publicKey: 'bm90LWEta2V5' };
    expect(() => verifyRegistration(reg, CH)).toThrow(/public key/);
  });

  it('refuses an algorithm it does not verify', () => {
    const reg = { ...new SoftAuthenticator().register(CH), alg: -8 };
    expect(() => verifyRegistration(reg as any, CH)).toThrow(/algorithm/);
  });
});

describe('verifyAssertion', () => {
  const enrolled = () => {
    const a = new SoftAuthenticator();
    return { a, cred: { ...verifyRegistration(a.register(CH), CH), signCount: 0 } };
  };

  it('accepts a signature by the enrolled passkey over this challenge, and reports the sign count', () => {
    const { a, cred } = enrolled();
    expect(verifyAssertion(a.assert(CH), cred, CH).signCount).toBe(1);
  });

  it('refuses a signature by another key under the same credential id', () => {
    const { cred } = enrolled();
    const other = new SoftAuthenticator();
    expect(() => verifyAssertion({ ...other.assert(CH), credentialId: cred.id }, cred, CH)).toThrow(/signature/);
  });

  it('refuses a tampered clientDataJSON', () => {
    const { a, cred } = enrolled();
    const good = a.assert(CH);
    const forged = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: CH, origin: 'http://localhost:5173', crossOrigin: true })).toString('base64url');
    expect(() => verifyAssertion({ ...good, clientDataJSON: forged }, cred, CH)).toThrow(/signature/);
  });

  it.each([
    ['another challenge', (a: SoftAuthenticator) => a.assert('other'), /challenge/],
    ['a creation instead of an assertion', (a: SoftAuthenticator) => a.assert(CH, { type: 'webauthn.create' }), /type/],
    ['a foreign origin', (a: SoftAuthenticator) => a.assert(CH, { origin: 'http://evil.example' }), /origin/],
    ['no user presence', (a: SoftAuthenticator) => a.assert(CH, { up: false }), /presen/],
    ['no user verification', (a: SoftAuthenticator) => a.assert(CH, { uv: false }), /verif/],
  ])('refuses %s', (_, make, why) => {
    const { a, cred } = enrolled();
    expect(() => verifyAssertion(make(a), cred, CH)).toThrow(why);
  });

  it('refuses a sign count that did not go up (a cloned authenticator)', () => {
    const { a, cred } = enrolled();
    expect(() => verifyAssertion(a.assert(CH, { signCount: 5 }), { ...cred, signCount: 5 }, CH)).toThrow(/sign count/);
  });

  it('accepts a sign count of zero from an authenticator that does not count', () => {
    const { a, cred } = enrolled();
    expect(verifyAssertion(a.assert(CH, { signCount: 0 }), { ...cred, signCount: 0 }, CH).signCount).toBe(0);
  });

  it('works for RS256', () => {
    const a = new SoftAuthenticator(-257);
    const cred = { ...verifyRegistration(a.register(CH), CH), signCount: 0 };
    expect(verifyAssertion(a.assert(CH), cred, CH).signCount).toBe(1);
  });
});
