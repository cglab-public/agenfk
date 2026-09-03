/**
 * CGLAB-131 — PR drill-down: the per-cell list links each PR to GitHub.
 * prUrlFor() derives the link from the OPENER event's authoritative remote_url
 * (canonical git remote, written at ingest); when that is absent it falls back
 * to the payload's `owner/repo` slug under the same documented github.com
 * assumption remoteUrlFromRepo() uses. Non-GitHub hosts (GHE custom domains,
 * GitLab, …) are deliberately NOT linked — the platform is not derivable from
 * the host, so the UI shows "repo #N" without a link instead of guessing.
 */
import { describe, it, expect } from 'vitest';
import { prUrlFor } from '../util/remoteUrl';

describe('prUrlFor', () => {
  it('derives the pull link from a canonical ssh github remote', () => {
    expect(prUrlFor('git@github.com:acme/api.git', null, 7))
      .toBe('https://github.com/acme/api/pull/7');
  });

  it('derives the pull link from an https github remote (no .git)', () => {
    expect(prUrlFor('https://github.com/acme/api', null, 12))
      .toBe('https://github.com/acme/api/pull/12');
  });

  it('tolerates a user prefix and a trailing .git in https remotes', () => {
    expect(prUrlFor('https://dev@github.com/acme/api.git', null, 3))
      .toBe('https://github.com/acme/api/pull/3');
  });

  it('returns null for non-GitHub ssh remotes (GHE custom domains are not guessed)', () => {
    expect(prUrlFor('git@ghe.internal:team/service.git', null, 5)).toBeNull();
  });

  it('returns null for non-GitHub https remotes (GitLab is not /pull/)', () => {
    expect(prUrlFor('https://gitlab.com/g/r.git', null, 9)).toBeNull();
  });

  it('falls back to the owner/repo slug when the remote is missing (documented github.com assumption)', () => {
    expect(prUrlFor(null, 'acme/api', 4))
      .toBe('https://github.com/acme/api/pull/4');
  });

  it('falls back to the slug with a trailing .git too', () => {
    expect(prUrlFor(null, 'acme/api.git', 4))
      .toBe('https://github.com/acme/api/pull/4');
  });

  it('does not fall back when the slug is host-qualified junk', () => {
    expect(prUrlFor(null, 'github.com/acme/api', 4)).toBeNull();
    expect(prUrlFor(null, 'not-a-repo', 4)).toBeNull();
  });

  it('returns null when neither remote nor slug is usable', () => {
    expect(prUrlFor(null, null, 4)).toBeNull();
    expect(prUrlFor('', '', 4)).toBeNull();
  });

  it('the authoritative remote wins over the slug — a non-github remote means no link, not a github guess', () => {
    expect(prUrlFor('git@ghe.internal:t/s.git', 'acme/api', 5)).toBeNull();
  });

  it('accepts a string prNumber (PG jsonb returns text) and normalises it', () => {
    expect(prUrlFor('git@github.com:acme/api.git', null, '7'))
      .toBe('https://github.com/acme/api/pull/7');
  });

  it('returns null for a missing or zero prNumber', () => {
    expect(prUrlFor('git@github.com:acme/api.git', null, null)).toBeNull();
    expect(prUrlFor('git@github.com:acme/api.git', null, 0)).toBeNull();
  });

  // Input-hygiene contract: stored remotes are canonical, but pre-fix rows
  // and slugs can carry stray whitespace/control chars — the link must still
  // resolve from them (pinning the trims + the noise-strip in both arms).
  it('tolerates surrounding whitespace in a remote', () => {
    expect(prUrlFor('  git@github.com:acme/api.git\n', null, 7))
      .toBe('https://github.com/acme/api/pull/7');
  });

  it('strips embedded noise (spaces/control chars) from a remote before parsing', () => {
    expect(prUrlFor('git@github.com:acme/api .git', null, 7))
      .toBe('https://github.com/acme/api/pull/7');
    // double noise run: the strip regex must be a quantified match, not a single-char one
    expect(prUrlFor('git@github.com:acme/api\t.git', null, 7))
      .toBe('https://github.com/acme/api/pull/7');
  });

  it('returns null for a non-empty remote that does not parse (no crash, no guess)', () => {
    expect(prUrlFor('junk-without-any-separator', null, 4)).toBeNull();
  });

  it('treats a whitespace-only remote as missing and falls back to the slug', () => {
    // The guard trims: a remote that is only whitespace must not short-circuit
    // the slug fallback (it carries no host information).
    expect(prUrlFor('   ', 'acme/api', 4))
      .toBe('https://github.com/acme/api/pull/4');
  });

  it('does not accept a github-looking suffix hidden behind garbage (anchor contract)', () => {
    // The parse regex is fully anchored: a string with a foreign prefix must
    // fail to parse in its entirety rather than match a trailing fragment.
    expect(prUrlFor('see https://x.example/ git@github.com:acme/api.git', null, 7)).toBeNull();
  });

  it('tolerates surrounding whitespace in a slug', () => {
    expect(prUrlFor(null, '  acme/api ', 4))
      .toBe('https://github.com/acme/api/pull/4');
  });

  it('strips embedded noise from a slug before matching', () => {
    expect(prUrlFor(null, 'acme/ my-api', 4))
      .toBe('https://github.com/acme/my-api/pull/4');
    // double noise run in the slug arm
    expect(prUrlFor(null, 'acme/  my-api', 4))
      .toBe('https://github.com/acme/my-api/pull/4');
  });
});
