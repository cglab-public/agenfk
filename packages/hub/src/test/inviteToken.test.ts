// Invite-token kinds and the legacy back-compat rule (CGLAB-181).
//
// Installation invites issued BEFORE federation existed carry no `kind` field.
// They must keep redeeming as installation invites, and must never satisfy a
// child-hub check. Nothing else pins that rule, so a tightening of the kind
// comparison would otherwise brick every outstanding `agenfk hub join` link
// with a green suite.
import { describe, it, expect } from 'vitest';
import { signInviteToken, verifyInviteToken, isUniqueViolation } from '../auth/inviteToken';

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
