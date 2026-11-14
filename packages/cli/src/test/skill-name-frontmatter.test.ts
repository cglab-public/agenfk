/**
 * The `name:` frontmatter field OpenCode, Codex, Cursor and Gemini require is
 * injected in two places: the installer (scripts/install-helpers.mjs
 * `withSkillName`) and the CLI's own command sync (`withSkillName` in
 * src/index.ts - a mirror, since this package's build cannot import from
 * scripts/). #208: a Windows checkout (core.autocrlf) opens a file with
 * `---\r\n`, which matching only `---\n` skipped. Both copies must agree on
 * every input, LF and CRLF alike, or one path drifts while the other is tested.
 */
import { describe, it, expect } from 'vitest';
import { withSkillName } from '../index';
// @ts-expect-error - plain .mjs module without type declarations
import { withSkillName as installerWithSkillName } from '../../../../scripts/install-helpers.mjs';

const CASES: Array<[string, string]> = [
  ['LF frontmatter without a name', '---\ndescription: d\n---\nbody\n'],
  ['CRLF frontmatter without a name', '---\r\ndescription: d\r\n---\r\nbody\r\n'],
  ['frontmatter that already has a name', '---\nname: other\ndescription: d\n---\n'],
  ['CRLF frontmatter that already has a name', '---\r\nname: other\r\n---\r\n'],
  ['no frontmatter at all', '# Title\nbody\n'],
];

describe('withSkillName (CLI command sync)', () => {
  it('injects the name in the file\'s own line ending', () => {
    expect(withSkillName('---\ndescription: d\n---\n', 'agenfk')).toBe('---\nname: agenfk\ndescription: d\n---\n');
    expect(withSkillName('---\r\ndescription: d\r\n---\r\n', 'agenfk')).toBe('---\r\nname: agenfk\r\ndescription: d\r\n---\r\n');
  });

  it('leaves a file that already names itself, or has no frontmatter, as it is', () => {
    expect(withSkillName('---\nname: other\n---\n', 'agenfk')).toBe('---\nname: other\n---\n');
    expect(withSkillName('# Title\n', 'agenfk')).toBe('# Title\n');
  });

  it.each(CASES)('agrees with the installer\'s copy: %s', (_label, content) => {
    expect(withSkillName(content, 'agenfk')).toBe(installerWithSkillName(content, 'agenfk'));
  });
});
