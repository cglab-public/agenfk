/**
 * PR Overview — the PR-number search parser (story 79220886).
 *
 * The parser is the whole contract of the search box: it decides whether what
 * the user typed is a PR search at all, and its return value is what the page
 * writes into `?pr=`. Two shapes must parse, because both are how people
 * actually reach a PR — a bare number (with or without the `#` they see in the
 * GitHub UI) and a pasted PR URL.
 *
 * Anything that is not a number is `null`, i.e. NO search. That is deliberate:
 * a half-typed box ("12a") must not narrow the overview to zero rows and leave
 * the reader thinking the data vanished.
 */
import { describe, it, expect } from 'vitest';
import { parsePrQuery } from '../prSearch';

describe('parsePrQuery', () => {
  it('parses a bare number', () => {
    expect(parsePrQuery('57')).toBe(57);
  });

  it('parses the number with the # people copy from GitHub', () => {
    expect(parsePrQuery('#57')).toBe(57);
  });

  it('trims surrounding whitespace (a pasted value carries it)', () => {
    expect(parsePrQuery('  57  ')).toBe(57);
    expect(parsePrQuery('\t#57\n')).toBe(57);
  });

  it('parses a pasted GitHub PR URL', () => {
    expect(parsePrQuery('https://github.com/acme/api/pull/57')).toBe(57);
  });

  it('parses a PR URL with a trailing path or anchor', () => {
    expect(parsePrQuery('https://github.com/acme/api/pull/57/files')).toBe(57);
    expect(parsePrQuery('https://github.com/acme/api/pull/57/')).toBe(57);
    expect(parsePrQuery('https://github.com/acme/api/pull/57#discussion_r1')).toBe(57);
  });

  it('parses a GitLab merge-request URL (the hub sizes PRs from any host)', () => {
    expect(parsePrQuery('https://gitlab.com/acme/api/-/merge_requests/57')).toBe(57);
  });

  it('takes the number from the URL, not from a repo or org that also has digits', () => {
    expect(parsePrQuery('https://github.com/acme2/api2/pull/57')).toBe(57);
  });

  it('keeps leading zeros as the same number', () => {
    expect(parsePrQuery('007')).toBe(7);
  });

  it('returns null for an empty or blank box — no search, all filters back', () => {
    expect(parsePrQuery('')).toBeNull();
    expect(parsePrQuery('   ')).toBeNull();
    expect(parsePrQuery('#')).toBeNull();
  });

  it('returns null for anything that is not a number (a half-typed box must not zero the page)', () => {
    expect(parsePrQuery('abc')).toBeNull();
    expect(parsePrQuery('12a')).toBeNull();
    expect(parsePrQuery('pr57')).toBeNull();
    expect(parsePrQuery('12.5')).toBeNull();
    expect(parsePrQuery('-57')).toBeNull();
    expect(parsePrQuery('57abc')).toBeNull();
  });

  it('returns null for a URL without a PR number in it', () => {
    expect(parsePrQuery('https://github.com/acme/api')).toBeNull();
    expect(parsePrQuery('https://github.com/acme/api/issues/57')).toBeNull();
  });

  it('returns null for numbers that cannot be a PR number', () => {
    expect(parsePrQuery('0')).toBeNull();
    expect(parsePrQuery('#0')).toBeNull();
    // beyond Number.MAX_SAFE_INTEGER the value is no longer exact — matching it
    // against the stored number would be a coincidence, not a match.
    expect(parsePrQuery('9007199254740993')).toBeNull();
  });

  it('accepts the largest number the match can represent exactly', () => {
    expect(parsePrQuery('9007199254740991')).toBe(9007199254740991);
  });
});
