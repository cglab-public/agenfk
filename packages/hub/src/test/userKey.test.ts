// Identity key derivation (task c534ab9a).
//
// The fallback used to be a BARE OS username, so every developer who is 'dev',
// 'ubuntu', 'runner' or 'ec2-user' on their own machine shared one identity:
// dashboards silently merged distinct people, and no automatic identity merge
// could ever be safe. Scoping the fallback to the installation makes a key mean
// exactly one machine.

import { describe, it, expect } from 'vitest';
import { userKeyFor, isEmailShapedKey, isNamespacedOsUserKey, namespacedOsUserKey } from '../util/userKey';

const actor = (over: Partial<{ osUser: string; gitName: string | null; gitEmail: string | null }> = {}) => ({
  osUser: 'dev',
  gitName: null,
  gitEmail: null,
  ...over,
});

describe('userKeyFor', () => {
  it('prefers the git email, lowercased', () => {
    expect(userKeyFor(actor({ gitEmail: 'Dev@Acme.com' }), 'inst-abc12345')).toBe('dev@acme.com');
  });

  it('ignores the installation entirely when there is a git email', () => {
    // A person is the same person on every machine — that is the whole point of
    // keying on the address.
    const a = userKeyFor(actor({ gitEmail: 'dev@acme.com' }), 'inst-one');
    const b = userKeyFor(actor({ gitEmail: 'dev@acme.com' }), 'inst-two');
    expect(a).toBe(b);
  });

  it('scopes the os-user fallback to the installation', () => {
    expect(userKeyFor(actor({ osUser: 'dev' }), 'abcdef1234567890')).toBe('osuser:dev@abcdef12');
  });

  it('gives two machines with the SAME os user different identities', () => {
    // The defect this task exists for.
    const alice = userKeyFor(actor({ osUser: 'dev' }), 'inst-alice-1');
    const bob = userKeyFor(actor({ osUser: 'dev' }), 'inst-bob-222');
    expect(alice).not.toBe(bob);
  });

  it('is stable for the same machine across calls', () => {
    const a = userKeyFor(actor({ osUser: 'dev' }), 'inst-abc12345');
    const b = userKeyFor(actor({ osUser: 'dev' }), 'inst-abc12345');
    expect(a).toBe(b);
  });

  it('treats an empty or whitespace git email as absent', () => {
    expect(userKeyFor(actor({ gitEmail: '' }), 'inst-abc12345')).toBe('osuser:dev@abc12345');
    expect(userKeyFor(actor({ gitEmail: '   ' }), 'inst-abc12345')).toBe('osuser:dev@abc12345');
  });

  it('namespaces the unknown case too, so it cannot collide across machines', () => {
    const a = userKeyFor({ osUser: '', gitName: null, gitEmail: null }, 'inst-aaa11111');
    const b = userKeyFor({ osUser: '', gitName: null, gitEmail: null }, 'inst-bbb22222');
    expect(a).toContain('unknown');
    expect(a).not.toBe(b);
  });

  it('preserves os-user case, which is meaningful on Windows', () => {
    expect(userKeyFor(actor({ osUser: 'DPolistchuck' }), 'inst-abc12345')).toBe('osuser:DPolistchuck@abc12345');
  });

  it('produces a key that is not mistakable for an email address', () => {
    const key = userKeyFor(actor({ osUser: 'dev' }), 'inst-abc12345');
    expect(isEmailShapedKey(key)).toBe(false);
    expect(key.startsWith('osuser:')).toBe(true);
  });

  it('falls back to a bare os user when no installation id is available', () => {
    // Defensive: an event with no installation cannot be scoped, and inventing
    // a scope would be worse than the honest un-namespaced key.
    expect(userKeyFor(actor({ osUser: 'dev' }), '')).toBe('dev');
  });
});

describe('isEmailShapedKey', () => {
  it('recognises an address', () => {
    expect(isEmailShapedKey('dev@acme.com')).toBe(true);
  });

  it('rejects a bare username', () => {
    expect(isEmailShapedKey('dev')).toBe(false);
  });

  it('rejects a namespaced key even though it contains an @', () => {
    // This is what stops the migration from re-namespacing its own output.
    expect(isEmailShapedKey('osuser:dev@abc12345')).toBe(false);
  });
});

describe('isNamespacedOsUserKey', () => {
  it('recognises its own output', () => {
    expect(isNamespacedOsUserKey(namespacedOsUserKey('dev', 'inst-abc12345'))).toBe(true);
  });

  it('rejects bare usernames and emails', () => {
    expect(isNamespacedOsUserKey('dev')).toBe(false);
    expect(isNamespacedOsUserKey('dev@acme.com')).toBe(false);
  });
});
