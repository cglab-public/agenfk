import { describe, it, expect } from 'vitest';
import { sameHubUrl } from '../hubUrl';

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
