/**
 * A repeated param means the same thing on both sides of the wire.
 *
 * The server normalises ?childHubId=a&childHubId=b to the CSV form (parseList
 * in routes/queries.ts joins an array before splitting) and a hub test pins it
 * as supported. csvParam read only the FIRST occurrence, so a hand-written or
 * generated link in that spelling scoped the page to hub `a` alone — narrower
 * than the URL says, and with nothing on screen to reveal it.
 *
 * Found by the adversarial review of BUG b0167566.
 */
import { describe, it, expect } from 'vitest';
import { csvParam } from '../urlParams';

describe('csvParam', () => {
  it('reads a repeated param, not just the first one', () => {
    expect(csvParam(new URLSearchParams('childHubId=a&childHubId=b'), 'childHubId')).toEqual(['a', 'b']);
  });

  it('reads the CSV spelling', () => {
    expect(csvParam(new URLSearchParams('childHubId=a,b'), 'childHubId')).toEqual(['a', 'b']);
  });

  it('reads the two spellings mixed', () => {
    expect(csvParam(new URLSearchParams('x=a,b&x=c'), 'x')).toEqual(['a', 'b', 'c']);
  });

  it('still drops blanks and trims, from every occurrence', () => {
    expect(csvParam(new URLSearchParams('x= a , &x=,b '), 'x')).toEqual(['a', 'b']);
  });

  it('yields [] for an absent param', () => {
    expect(csvParam(new URLSearchParams(''), 'x')).toEqual([]);
  });
});
