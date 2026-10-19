/**
 * Phase 0 of the Hub auto-join epic (INFRA-463): the bind of an invited row
 * is conditional on the row still being unbound. When the UPDATE loses, the
 * row may have been bound by a concurrent callback for the SAME identity
 * (a double-submitted redirect): that sign-in gets the user, not a refusal.
 */
import { describe, it, expect } from 'vitest';
import { findInvitedSsoUser } from '../auth/oauth';

const invited = { id: 'u-1', org_id: 'org', email: 'bob@acme.com', name: null, password_hash: null, provider: 'password', provider_subject: null, role: 'viewer', active: 1 };

/** A DB whose bind UPDATE always loses, with the row bound to `boundTo` by then. */
function racingDb(boundTo: { provider: string; subject: string }) {
  let bySubjectReads = 0;
  return {
    get: async (sql: string, params: any[]) => {
      if (sql.includes('provider_subject = ?')) {
        bySubjectReads++;
        // First read: nobody bound yet. After the lost UPDATE: the winner's row.
        if (bySubjectReads === 1) return undefined;
        return params[0] === boundTo.provider && params[1] === boundTo.subject
          ? { ...invited, provider: boundTo.provider, provider_subject: boundTo.subject }
          : undefined;
      }
      if (sql.includes('lower(email)')) return invited;
      return undefined;
    },
    run: async () => ({ changes: 0 }),
    all: async () => [],
  } as any;
}

describe('findInvitedSsoUser when the conditional bind loses a race', () => {
  it('returns the user when the winner bound the same identity', async () => {
    const r = await findInvitedSsoUser(racingDb({ provider: 'entra', subject: 'oid-1' }), 'org', { provider: 'entra', subject: 'oid-1', email: 'bob@acme.com' });
    expect('user' in r && r.user.provider_subject).toBe('oid-1');
  });

  it('refuses when the winner bound another identity', async () => {
    const r = await findInvitedSsoUser(racingDb({ provider: 'entra', subject: 'oid-other' }), 'org', { provider: 'entra', subject: 'oid-1', email: 'bob@acme.com' });
    expect(r).toEqual({ refused: 'bound-elsewhere' });
  });
});
