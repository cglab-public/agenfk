import { describe, it, expect } from 'vitest';
import { sameHubUrl, stripTrailingSlashes } from '../hubUrl';

// A run of slashes followed by another character is the input a backtracking
// `/\/+$/` rescans from every start position: 3 s at this length, quadratic.
const SLASH_RUN = `https://hub.acme.com${'/'.repeat(100_000)}x`;

describe('stripTrailingSlashes', () => {
  it.each<[string, string, string]>([
    ['no trailing slash', 'https://hub.acme.com', 'https://hub.acme.com'],
    ['one trailing slash', 'https://hub.acme.com/', 'https://hub.acme.com'],
    ['several trailing slashes', 'https://hub.acme.com///', 'https://hub.acme.com'],
    ['slashes inside are kept', 'https://hub.acme.com/a/b/', 'https://hub.acme.com/a/b'],
    ['only slashes', '///', ''],
    ['the empty string', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected);
  });

  it('is linear on a long slash run that does not end the string', () => {
    const started = performance.now();
    expect(stripTrailingSlashes(SLASH_RUN)).toBe(SLASH_RUN);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('sameHubUrl on hostile input', () => {
  it('compares two long slash runs without rescanning them', () => {
    const started = performance.now();
    expect(sameHubUrl(SLASH_RUN, SLASH_RUN)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('sameHubUrl', () => {
  it.each<[string, unknown, unknown, boolean]>([
    ['the same URL', 'https://hub.acme.com', 'https://hub.acme.com', true],
    ['a trailing slash on the first', 'https://hub.acme.com/', 'https://hub.acme.com', true],
    ['a trailing slash on the second', 'https://hub.acme.com', 'https://hub.acme.com/', true],
    ['several trailing slashes on both', 'https://hub.acme.com//', 'https://hub.acme.com/', true],
    ['a different host', 'https://hub.acme.com', 'https://hub.other.com', false],
    ['http against https', 'http://hub.acme.com', 'https://hub.acme.com', false],
    ['a different path', 'https://hub.acme.com/a', 'https://hub.acme.com', false],
    ['two empty strings', '', '', false],
    ['only slashes', '/', '/', false],
    ['undefined on one side', undefined, 'https://hub.acme.com', false],
    ['undefined on both', undefined, undefined, false],
    ['null on one side', 'https://hub.acme.com', null, false],
    ['a number', 123, 'https://hub.acme.com', false],
    ['two equal numbers', 123, 123, false],
    ['an object', {}, 'https://hub.acme.com', false],
  ])('%s', (_name, a, b, expected) => {
    expect(sameHubUrl(a, b)).toBe(expected);
  });
});
