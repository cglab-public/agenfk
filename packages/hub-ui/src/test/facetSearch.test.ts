import { describe, it, expect } from 'vitest';
import { filterFacetOptions, shortRemote } from '../components/facetSearch';

describe('shortRemote', () => {
  it('extracts owner/repo from ssh url', () => {
    expect(shortRemote('git@github.com:acme/web.git')).toBe('acme/web');
  });
  it('extracts owner/repo from https url', () => {
    expect(shortRemote('https://github.com/acme/web.git')).toBe('acme/web');
  });
  it('extracts owner/repo without .git suffix', () => {
    expect(shortRemote('https://gitlab.com/foo/bar')).toBe('foo/bar');
  });
  it('returns input when nothing matches', () => {
    expect(shortRemote('not-a-url')).toBe('not-a-url');
  });
});

describe('filterFacetOptions', () => {
  const remotes = [
    'git@github.com:acme/web.git',
    'git@github.com:acme/api.git',
    'https://github.com/contoso/portal.git',
    'https://github.com/contoso/cli.git',
  ];

  it('returns all options when query is empty', () => {
    expect(filterFacetOptions(remotes, '')).toEqual(remotes);
  });

  it('returns all options when query is whitespace', () => {
    expect(filterFacetOptions(remotes, '   ')).toEqual(remotes);
  });

  it('filters case-insensitively against the raw value', () => {
    expect(filterFacetOptions(remotes, 'CONTOSO')).toEqual([
      'https://github.com/contoso/portal.git',
      'https://github.com/contoso/cli.git',
    ]);
  });

  it('filters against the labelled form when optionLabel is provided', () => {
    // shortRemote strips .git, so a query matching the short form should match
    // even if the raw remote contains characters that would not match.
    const r = filterFacetOptions(remotes, 'acme/web', shortRemote);
    expect(r).toEqual(['git@github.com:acme/web.git']);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterFacetOptions(remotes, 'does-not-exist')).toEqual([]);
  });

  it('matches partial fragments', () => {
    expect(filterFacetOptions(remotes, 'cli')).toEqual([
      'https://github.com/contoso/cli.git',
    ]);
  });
});
