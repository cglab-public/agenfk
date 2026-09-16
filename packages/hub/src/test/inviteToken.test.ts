// Invite-token kinds and the legacy back-compat rule (CGLAB-181).
//
// Installation invites issued BEFORE federation existed carry no `kind` field.
// They must keep redeeming as installation invites, and must never satisfy a
// child-hub check. Nothing else pins that rule, so a tightening of the kind
// comparison would otherwise brick every outstanding `agenfk hub join` link
// with a green suite.
import { describe, it, expect } from 'vitest';
import { signInviteToken, verifyInviteToken, isUniqueViolation, parentUrlFromInviteToken, inviteExpiryFromToken } from '../auth/inviteToken';
import { assertHttpUrl } from '../services/federation/parentBinding';

const SECRET = 'a'.repeat(64);
const base = { orgId: 'org', nonce: 'n1', exp: Date.now() + 60_000 };

describe('inviteToken kinds', () => {
  it('treats a legacy token with no kind as an installation invite', () => {
    const token = signInviteToken({ ...base }, SECRET);
    const asInstallation = verifyInviteToken(token, SECRET, 'installation');
    expect(asInstallation).toMatchObject({ orgId: 'org', nonce: 'n1', kind: 'installation' });
    expect(verifyInviteToken(token, SECRET, 'child-hub')).toBeNull();
  });

  it('round-trips each explicit kind and refuses the other', () => {
    const inst = signInviteToken({ ...base, kind: 'installation' }, SECRET);
    expect(verifyInviteToken(inst, SECRET, 'installation')?.kind).toBe('installation');
    expect(verifyInviteToken(inst, SECRET, 'child-hub')).toBeNull();

    const child = signInviteToken({ ...base, kind: 'child-hub' }, SECRET);
    expect(verifyInviteToken(child, SECRET, 'child-hub')?.kind).toBe('child-hub');
    expect(verifyInviteToken(child, SECRET, 'installation')).toBeNull();
  });

  it('rejects an unknown kind rather than falling back to installation', () => {
    const weird = signInviteToken({ ...base, kind: 'admin' as any }, SECRET);
    expect(verifyInviteToken(weird, SECRET, 'installation')).toBeNull();
    expect(verifyInviteToken(weird, SECRET, 'child-hub')).toBeNull();
  });

  it('rejects a tampered signature, a tampered body, and a wrong secret', () => {
    const token = signInviteToken({ ...base, kind: 'child-hub' }, SECRET);
    const [body, sig] = token.split('.');
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    expect(verifyInviteToken(`${body}.${flip(sig)}`, SECRET, 'child-hub')).toBeNull();
    expect(verifyInviteToken(`${flip(body)}.${sig}`, SECRET, 'child-hub')).toBeNull();
    expect(verifyInviteToken(token, 'b'.repeat(64), 'child-hub')).toBeNull();
    // and the untampered token still verifies, so the assertions above are not
    // passing for some unrelated reason
    expect(verifyInviteToken(token, SECRET, 'child-hub')).not.toBeNull();
  });

  it('rejects structurally invalid tokens', () => {
    expect(verifyInviteToken('', SECRET, 'child-hub')).toBeNull();
    expect(verifyInviteToken('nodot', SECRET, 'child-hub')).toBeNull();
    expect(verifyInviteToken('.sig', SECRET, 'child-hub')).toBeNull();
    const noExp = signInviteToken({ orgId: 'o', nonce: 'n' } as any, SECRET);
    expect(verifyInviteToken(noExp, SECRET, 'installation')).toBeNull();
  });
});

describe('isUniqueViolation', () => {
  it('recognises the Postgres and SQLite signals', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: used_invites.nonce'))).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isUniqueViolation(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isUniqueViolation({ code: '08006' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

// A child-hub invite carries the parent's own URL (CGLAB-181 follow-up).
//
// The point is that an admin on the child hub pastes ONE value. That only
// works if the URL travels inside the token, and if the child can read it
// back WITHOUT the parent's secret — the child has no way to verify the
// signature, only the parent can. So the read is deliberately unverified,
// and every caller must still run the URL through its own SSRF guard.
describe('child-hub invite carries the parent URL', () => {
  const child = { ...base, kind: 'child-hub' as const, parentUrl: 'https://parent.example.com' };

  it('round-trips the parent URL through sign/verify', () => {
    const token = signInviteToken(child, SECRET);
    expect(verifyInviteToken(token, SECRET, 'child-hub')).toMatchObject({
      orgId: 'org', nonce: 'n1', kind: 'child-hub', parentUrl: 'https://parent.example.com',
    });
  });

  it('reads the parent URL back without the signing secret', () => {
    const token = signInviteToken(child, SECRET);
    expect(parentUrlFromInviteToken(token)).toBe('https://parent.example.com');
  });

  it('returns null for a token that carries no parent URL', () => {
    // Invites minted before this change. There is no fallback by design: the
    // admin is told to ask for a fresh token rather than shown a URL box again.
    const token = signInviteToken({ ...base, kind: 'child-hub' }, SECRET);
    expect(parentUrlFromInviteToken(token)).toBeNull();
  });

  it('returns null rather than throwing on junk', () => {
    expect(parentUrlFromInviteToken('')).toBeNull();
    expect(parentUrlFromInviteToken('nodot')).toBeNull();
    expect(parentUrlFromInviteToken('.sig')).toBeNull();
    expect(parentUrlFromInviteToken('!!!!.sig')).toBeNull();
    expect(parentUrlFromInviteToken(`${Buffer.from('not json').toString('base64url')}.sig`)).toBeNull();
  });

  it('refuses a non-http parent URL inside the token', () => {
    // The decode is unverified, so it is the first place a hostile token can
    // aim the child at something. file:// and javascript: never leave here.
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.example.com', 'not a url']) {
      const token = signInviteToken({ ...base, kind: 'child-hub', parentUrl: bad }, SECRET);
      expect(parentUrlFromInviteToken(token)).toBeNull();
    }
  });

  it('refuses a non-string parent URL inside the token', () => {
    const token = signInviteToken({ ...base, kind: 'child-hub', parentUrl: { href: 'https://x' } as any }, SECRET);
    expect(parentUrlFromInviteToken(token)).toBeNull();
  });

  it('refuses an absurdly long token before decoding it', () => {
    expect(parentUrlFromInviteToken('x'.repeat(5000) + '.sig')).toBeNull();
  });
});

// Review findings on the self-describing token (CGLAB-181 follow-up).
//
// The child cannot verify the signature, so the ONLY thing standing between an
// admin and a hostile parent is the URL shown to them before they click Join.
// That makes the returned string a security control, and it has to be the
// string the client will actually dial — not a prettier one.
describe('the decoded URL is the URL that gets dialled', () => {
  const tokenFor = (parentUrl: string) =>
    signInviteToken({ ...base, kind: 'child-hub', parentUrl }, SECRET);

  it('agrees with assertHttpUrl for every shape that reaches both', () => {
    // Pinned as an equality rather than two copies of the rule: these are the
    // display value and the dialled value, and they drift silently otherwise.
    for (const raw of [
      'https://parent.example.com',
      'https://parent.example.com/',
      'https://parent.example.com/base/',
      'https://parent.example.com:8443/x',
      'http://parent.example.com',
      'https://parent.example.com@evil.example.com/x',
      'https://PARENT.example.com',
      'https://ok.example.com\n',
    ]) {
      expect(parentUrlFromInviteToken(tokenFor(raw)), raw)
        .toBe(assertHttpUrl(raw, { allowPrivate: true }));
    }
  });

  it('strips userinfo, so the hostname on screen is the host contacted', () => {
    // Reads as parent.example.com at a glance; dials evil.example.com.
    expect(parentUrlFromInviteToken(tokenFor('https://parent.example.com@evil.example.com/x')))
      .toBe('https://evil.example.com/x');
  });

  it('refuses an array, which URL() would otherwise coerce to a string', () => {
    // new URL(['https://evil.example.com']) succeeds. Without the typeof guard
    // this function would hand an array on to a caller expecting a string.
    const token = signInviteToken(
      { ...base, kind: 'child-hub', parentUrl: ['https://evil.example.com'] as any }, SECRET,
    );
    expect(parentUrlFromInviteToken(token)).toBeNull();
  });

  it('refuses a token that is not a child-hub invite', () => {
    // Pasting an installation invite into the join box should fail locally
    // with a clear message, not after a round trip to somebody's server.
    const inst = signInviteToken(
      { ...base, kind: 'installation', parentUrl: 'https://parent.example.com' }, SECRET,
    );
    expect(parentUrlFromInviteToken(inst)).toBeNull();
    const kindless = signInviteToken(
      { orgId: 'org', nonce: 'n', exp: base.exp, parentUrl: 'https://parent.example.com' } as any, SECRET,
    );
    expect(parentUrlFromInviteToken(kindless)).toBeNull();
  });

  it('refuses an over-long token whose body is otherwise perfectly valid', () => {
    // The earlier junk-length case passed with the bound removed, because the
    // junk failed to parse anyway. This one only fails if the bound is real.
    const huge = tokenFor(`https://parent.example.com/${'a'.repeat(6000)}`);
    expect(huge.length).toBeGreaterThan(4096);
    expect(parentUrlFromInviteToken(huge)).toBeNull();
    // and the same URL just under the cap still works, so the cap is the reason
    expect(parentUrlFromInviteToken(tokenFor('https://parent.example.com/a'))).not.toBeNull();
  });

  it('reads the expiry so the child can refuse a stale token locally', () => {
    const expired = signInviteToken(
      { orgId: 'org', nonce: 'n', exp: Date.now() - 1000, kind: 'child-hub', parentUrl: 'https://parent.example.com' },
      SECRET,
    );
    expect(inviteExpiryFromToken(expired)).toBeLessThan(Date.now());
    expect(inviteExpiryFromToken(tokenFor('https://parent.example.com'))).toBe(base.exp);
    expect(inviteExpiryFromToken('nonsense')).toBeNull();
  });
});
