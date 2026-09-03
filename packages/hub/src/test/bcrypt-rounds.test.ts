/**
 * bcrypt cost is env-configurable so the test run can afford ~238 synchronous
 * hash/compare ops (see scripts/vitest-home-pin.mjs `testEnv`). These specs pin
 * the contract that makes that safe: production keeps rounds 11, the override
 * is clamped into bcryptjs' valid range, a bad value can never weaken the
 * default, and a low-cost hash still verifies — i.e. dropping the cost in tests
 * does not silently change the auth contract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { getBcryptRounds, hashPassword, verifyPassword } from '../auth/password';

const ENV = 'AGENFK_HUB_BCRYPT_ROUNDS';
const original = process.env[ENV];

const withRounds = (value: string | undefined, fn: () => void) => {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  }
};

describe('getBcryptRounds', () => {
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('defaults to the production cost of 11 when the env var is absent', () => {
    withRounds(undefined, () => expect(getBcryptRounds()).toBe(11));
  });

  it('honours a valid override', () => {
    withRounds('4', () => expect(getBcryptRounds()).toBe(4));
    withRounds(' 6 ', () => expect(getBcryptRounds()).toBe(6));
  });

  it('clamps below bcryptjs\' minimum rather than throwing at first login', () => {
    withRounds('1', () => expect(getBcryptRounds()).toBe(4));
    withRounds('0', () => expect(getBcryptRounds()).toBe(4));
  });

  it('clamps above bcryptjs\' maximum', () => {
    withRounds('40', () => expect(getBcryptRounds()).toBe(31));
  });

  it('falls back to the production default on a non-numeric value', () => {
    withRounds('banana', () => expect(getBcryptRounds()).toBe(11));
  });

  it('is read lazily, so a value set after module import still applies', () => {
    // Guards against a module-load-time constant, which would make the vitest
    // env pin silently ineffective (tests would keep paying rounds=11).
    withRounds(undefined, () => expect(getBcryptRounds()).toBe(11));
    withRounds('4', () => expect(getBcryptRounds()).toBe(4));
  });
});

describe('hashPassword under a reduced cost', () => {
  it('produces a standard bcrypt hash that still verifies', () => {
    withRounds('4', () => {
      const hash = hashPassword('longenough1');
      expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
      expect(hash).toContain('$04$');
      expect(verifyPassword('longenough1', hash)).toBe(true);
      expect(verifyPassword('wrong-password', hash)).toBe(false);
    });
  });

  it('hashes at the configured cost, not the default', () => {
    withRounds('4', () => {
      const roundsInHash = Number.parseInt(hashPassword('longenough1').split('$')[2], 10);
      expect(roundsInHash).toBe(4);
    });
  });

  it('a reduced-cost hash is still comparable by bcrypt directly (format unchanged)', () => {
    withRounds('4', () => {
      expect(bcrypt.compareSync('longenough1', hashPassword('longenough1'))).toBe(true);
    });
  });
});
