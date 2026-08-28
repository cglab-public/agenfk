/**
 * CGLAB-109: token count estimate for the exit-criteria markdown editor.
 *
 * The estimate is a client-side heuristic (chars/4 — the standard
 * GPT-family approximation), shown under the editor so authors can see the
 * context cost of their criteria before saving. It is a pure function, so it
 * is pinned exhaustively and is the prime mutation-testing target for this
 * story's MUTATION_TESTS step.
 */
import { describe, it, expect } from 'vitest';
import { estimateTokenCount } from '../estimateTokens';

describe('estimateTokenCount', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('returns 0 for whitespace-only input', () => {
    expect(estimateTokenCount('   \n\t  ')).toBe(0);
  });

  it('estimates 4 characters as one token', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('a')).toBe(1);
    expect(estimateTokenCount('ab')).toBe(1);
    expect(estimateTokenCount('abc')).toBe(1);
  });

  it('scales linearly: 400 chars is 100 tokens, 404 is 101', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
    expect(estimateTokenCount('a'.repeat(401))).toBe(101);
    expect(estimateTokenCount('a'.repeat(404))).toBe(101);
    expect(estimateTokenCount('a'.repeat(405))).toBe(102);
  });

  it('ignores surrounding whitespace in the count', () => {
    expect(estimateTokenCount('  hello world  ')).toBe(estimateTokenCount('hello world'));
    expect(estimateTokenCount('  hello world  ')).toBe(3); // 11 chars -> ceil(11/4)
  });

  it('counts markdown syntax as characters (it costs context too)', () => {
    const plain = 'all tests passing';
    const md = '**all tests passing**';
    expect(estimateTokenCount(md)).toBeGreaterThan(estimateTokenCount(plain));
  });

  it('always returns a non-negative integer', () => {
    for (const s of ['', 'a', 'hello', 'a'.repeat(12345), 'émoji 🚀 test']) {
      const n = estimateTokenCount(s);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotonic in trimmed length', () => {
    let max = 0;
    for (let len = 0; len <= 200; len += 7) {
      const n = estimateTokenCount('x'.repeat(len));
      expect(n).toBeGreaterThanOrEqual(max);
      max = n;
    }
  });
});
