import { describe, it, expect } from 'vitest';
import {
  isAttributedByUsername,
  attributionWarning,
  countAttributedByUsername,
  type AttributableRowLike,
} from '../pages/attributionWarning';

const row = (over: Partial<AttributableRowLike> = {}): AttributableRowLike => ({
  gitEmail: 'dev@acme.com',
  osUser: 'dev',
  ...over,
});

describe('isAttributedByUsername', () => {
  it('flags an installation with no git email', () => {
    // userKeyFor is gitEmail || osUser, so this install's whole history is
    // filed under an OS username rather than a person.
    expect(isAttributedByUsername(row({ gitEmail: null }))).toBe(true);
  });

  it('flags an empty or whitespace git email', () => {
    expect(isAttributedByUsername(row({ gitEmail: '' }))).toBe(true);
    expect(isAttributedByUsername(row({ gitEmail: '   ' }))).toBe(true);
  });

  it('does not flag an installation with a git email', () => {
    expect(isAttributedByUsername(row())).toBe(false);
  });

  it('still flags when there is no os user either — attribution is "unknown"', () => {
    expect(isAttributedByUsername(row({ gitEmail: null, osUser: null }))).toBe(true);
  });
});

describe('attributionWarning', () => {
  it('names the consequence, not just the missing setting', () => {
    const msg = attributionWarning('dev').toLowerCase();
    expect(msg).toContain('dev');
    // A bare "git email not set" tells an admin nothing about why they care.
    expect(msg).toMatch(/attribut|dashboard|metric/);
  });

  it('says what to do about it', () => {
    expect(attributionWarning('dev')).toMatch(/user\.email/);
  });

  it('handles an unknown username without printing undefined', () => {
    const msg = attributionWarning(null);
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('null');
  });
});

describe('countAttributedByUsername', () => {
  it('counts only the affected rows', () => {
    expect(countAttributedByUsername([
      row(),
      row({ gitEmail: null }),
      row({ gitEmail: '' }),
    ])).toBe(2);
  });

  it('is zero for an empty fleet', () => {
    expect(countAttributedByUsername([])).toBe(0);
  });
});
