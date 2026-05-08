import { describe, it, expect } from 'vitest';
import { buildSetupPayload, canSubmitSetup } from '../pages/setupSubmit';

describe('buildSetupPayload', () => {
  it('returns token + email + password as the body shape the hub expects', () => {
    expect(buildSetupPayload({ token: 't', email: 'a@b', password: 'longenough1' })).toEqual({
      token: 't',
      email: 'a@b',
      password: 'longenough1',
    });
  });

  it('trims surrounding whitespace from the token (operator paste-with-space is common)', () => {
    expect(buildSetupPayload({ token: '  abc  ', email: 'a@b', password: 'longenough1' }).token).toBe('abc');
  });

  it('does not trim email or password (server owns those)', () => {
    const out = buildSetupPayload({ token: 't', email: '  a@b  ', password: '  longenough1  ' });
    expect(out.email).toBe('  a@b  ');
    expect(out.password).toBe('  longenough1  ');
  });
});

describe('canSubmitSetup', () => {
  const base = { token: 'abc', email: 'a@b', password: 'longenough1', isPending: false };

  it('enabled when all fields are present and not pending', () => {
    expect(canSubmitSetup(base)).toBe(true);
  });

  it('disabled while a request is in flight', () => {
    expect(canSubmitSetup({ ...base, isPending: true })).toBe(false);
  });

  it('disabled when the token is empty or whitespace-only', () => {
    expect(canSubmitSetup({ ...base, token: '' })).toBe(false);
    expect(canSubmitSetup({ ...base, token: '   ' })).toBe(false);
  });

  it('disabled when email is empty', () => {
    expect(canSubmitSetup({ ...base, email: '' })).toBe(false);
  });

  it('disabled when password is shorter than 8 chars', () => {
    expect(canSubmitSetup({ ...base, password: 'short' })).toBe(false);
    expect(canSubmitSetup({ ...base, password: '1234567' })).toBe(false);
    expect(canSubmitSetup({ ...base, password: '12345678' })).toBe(true);
  });
});
