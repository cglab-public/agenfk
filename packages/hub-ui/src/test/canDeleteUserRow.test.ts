import { describe, it, expect } from 'vitest';
import { canDeleteUserRow } from '../pages/canDeleteUserRow';

describe('canDeleteUserRow', () => {
  it('returns true for a different user id', () => {
    expect(canDeleteUserRow('alice', 'bob')).toBe(true);
  });

  it('returns false when the row is the signed-in user (no self-delete)', () => {
    expect(canDeleteUserRow('me', 'me')).toBe(false);
  });

  it('returns false when the session user id is missing (still loading /auth/me)', () => {
    expect(canDeleteUserRow('alice', null)).toBe(false);
    expect(canDeleteUserRow('alice', undefined)).toBe(false);
  });
});
