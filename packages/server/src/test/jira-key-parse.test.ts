/**
 * JIRA key parsing — the format gate in front of every link.
 *
 * `--jira-item` reaches the server as free text, and on the offline path (no
 * OAuth token) the format check is the ONLY thing standing between a typo and a
 * card that advertises a JIRA badge pointing at nothing. So the parser has to be
 * strict about what a JIRA issue key actually is, and it has to normalise, since
 * users type `cglab-163` as readily as `CGLAB-163`.
 *
 * `none` is the unlink sentinel. It is unambiguous precisely because a bare word
 * with no `-<number>` suffix is never a valid key, so no real project can
 * collide with it — a property worth pinning, because it is the reason the
 * sentinel is safe at all.
 */
import { describe, it, expect } from 'vitest';
import { parseJiraKey, JIRA_UNLINK_SENTINEL } from '../server';

describe('parseJiraKey', () => {
  it('accepts a conventional PROJECT-123 key', () => {
    expect(parseJiraKey('CGLAB-163')).toBe('CGLAB-163');
  });

  it('normalises a lowercase key to the canonical uppercase form', () => {
    expect(parseJiraKey('cglab-163')).toBe('CGLAB-163');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseJiraKey('  CGLAB-163  ')).toBe('CGLAB-163');
  });

  it('accepts digits and underscores inside the project key', () => {
    expect(parseJiraKey('AB2_C-7')).toBe('AB2_C-7');
  });

  it('rejects a key whose project part does not start with a letter', () => {
    expect(parseJiraKey('1CGLAB-163')).toBeNull();
  });

  it('rejects a single-character project key', () => {
    expect(parseJiraKey('C-163')).toBeNull();
  });

  it('rejects a key with no issue number', () => {
    expect(parseJiraKey('CGLAB-')).toBeNull();
    expect(parseJiraKey('CGLAB')).toBeNull();
  });

  it('rejects a non-numeric issue number', () => {
    expect(parseJiraKey('CGLAB-16a')).toBeNull();
  });

  it('rejects free text and anything that is not a string', () => {
    expect(parseJiraKey('not a key')).toBeNull();
    expect(parseJiraKey('')).toBeNull();
    expect(parseJiraKey(undefined)).toBeNull();
    expect(parseJiraKey(null)).toBeNull();
    expect(parseJiraKey(42)).toBeNull();
    expect(parseJiraKey({ key: 'CGLAB-163' })).toBeNull();
  });

  it('rejects an embedded key rather than extracting it, so a URL is not mistaken for a key', () => {
    expect(parseJiraKey('https://cg-lab.atlassian.net/browse/CGLAB-163')).toBeNull();
    expect(parseJiraKey('see CGLAB-163 for details')).toBeNull();
  });

  // ── found in adversarial review ────────────────────────────────────────────

  it('rejects a project key that is a letter followed only by underscores', () => {
    // 'A_-1' passed the original grammar. JIRA issues no such key, and on the
    // disconnected path this parser is the only gate there is.
    expect(parseJiraKey('A_-1')).toBeNull();
    expect(parseJiraKey('A__-1')).toBeNull();
  });

  it('rejects a project key ending in an underscore', () => {
    expect(parseJiraKey('AB_-1')).toBeNull();
  });

  it('still accepts an underscore BETWEEN alphanumerics', () => {
    expect(parseJiraKey('A_B-1')).toBe('A_B-1');
  });

  it('does not let a non-ASCII character fold into an ASCII key', () => {
    // toUpperCase() maps 'ﬀ' to 'FF', so matching after upper-casing accepted
    // 'ﬀ-1' as 'FF-1'. The grammar is matched on the raw input for this reason.
    expect(parseJiraKey('ﬀ-1')).toBeNull();
    expect(parseJiraKey('ı_b-1')).toBeNull();
  });

  it('rejects issue number zero and leading zeros', () => {
    // JIRA numbers issues from 1, and 'AB-007' would be a second spelling of
    // 'AB-7' — two cards could then carry different externalIds for one issue.
    expect(parseJiraKey('AB-0')).toBeNull();
    expect(parseJiraKey('AB-007')).toBeNull();
    expect(parseJiraKey('AB-7')).toBe('AB-7');
  });

  it('rejects a key longer than the bound, which was the way around both length caps', () => {
    expect(parseJiraKey(`${'A'.repeat(5000)}-1`)).toBeNull();
    expect(parseJiraKey(`AB-${'9'.repeat(400)}`)).toBeNull();
  });

  it('accepts a key of a realistic length', () => {
    expect(parseJiraKey('ABCDEFGHIJ-123456')).toBe('ABCDEFGHIJ-123456');
  });

  it('never parses the unlink sentinel as a key, in any casing', () => {
    expect(parseJiraKey(JIRA_UNLINK_SENTINEL)).toBeNull();
    expect(parseJiraKey('none')).toBeNull();
    expect(parseJiraKey('NONE')).toBeNull();
  });
});
