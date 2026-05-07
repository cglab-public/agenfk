/**
 * Story 3: admin UI org-rename helpers (validation + spoke-command template).
 * Pure-logic tests, in line with the existing hub-ui test convention.
 */
import { describe, it, expect } from 'vitest';
import {
  validateOrgIdInput,
  spokeRepointCommand,
  ORG_ID_RENAME_REGEX,
} from '../pages/adminOrgRename';

describe('ORG_ID_RENAME_REGEX', () => {
  it('matches the server-side regex used in routes/orgRename.ts', () => {
    // Spec: ^[a-z0-9][a-z0-9-]{1,62}$  (length 2..63 inclusive)
    expect('cglab').toMatch(ORG_ID_RENAME_REGEX);
    expect('a1').toMatch(ORG_ID_RENAME_REGEX);
    expect('foo-bar-baz').toMatch(ORG_ID_RENAME_REGEX);
    expect('a'.repeat(63)).toMatch(ORG_ID_RENAME_REGEX);
    // Negatives.
    expect('A').not.toMatch(ORG_ID_RENAME_REGEX);                 // uppercase
    expect('-leading').not.toMatch(ORG_ID_RENAME_REGEX);          // leading dash
    expect('').not.toMatch(ORG_ID_RENAME_REGEX);                  // empty
    expect('a'.repeat(64)).not.toMatch(ORG_ID_RENAME_REGEX);      // too long
    expect('has space').not.toMatch(ORG_ID_RENAME_REGEX);
    expect('has_underscore').not.toMatch(ORG_ID_RENAME_REGEX);
    expect('a').not.toMatch(ORG_ID_RENAME_REGEX);                 // single char (server requires {1,62} after the leading char => length 2..63)
  });
});

describe('validateOrgIdInput', () => {
  it('returns null on a valid candidate', () => {
    expect(validateOrgIdInput('cglab', 'staging')).toBeNull();
  });
  it('reports empty input', () => {
    expect(validateOrgIdInput('', 'staging')).toMatch(/required|empty|enter/i);
  });
  it('reports identical to current', () => {
    expect(validateOrgIdInput('staging', 'staging')).toMatch(/different|same|unchanged/i);
  });
  it('reports format violations', () => {
    expect(validateOrgIdInput('UPPER', 'staging')).toMatch(/lowercase|format|invalid/i);
    expect(validateOrgIdInput('-bad', 'staging')).toMatch(/start|format|invalid/i);
    expect(validateOrgIdInput('with space', 'staging')).toMatch(/format|invalid/i);
  });
});

describe('spokeRepointCommand', () => {
  it('builds the canonical one-liner using window-origin URL and the new org id', () => {
    expect(spokeRepointCommand({ hubUrl: 'https://afk-hub.prd.cglab.com', orgId: 'cglab' }))
      .toBe('agenfk hub repoint --url https://afk-hub.prd.cglab.com --org-id cglab');
  });
  it('strips a trailing slash from the URL', () => {
    expect(spokeRepointCommand({ hubUrl: 'https://hub.example.com/', orgId: 'foo' }))
      .toBe('agenfk hub repoint --url https://hub.example.com --org-id foo');
  });
  it('shell-quotes nothing for safe values (no surprises in the copy)', () => {
    // Both inputs already pass the strict orgId regex / URL parsing,
    // so the rendered command must NOT add quotes.
    const cmd = spokeRepointCommand({ hubUrl: 'https://x', orgId: 'y' });
    expect(cmd.includes("'")).toBe(false);
    expect(cmd.includes('"')).toBe(false);
  });
});
