// Child-side event forwarding (CGLAB-184, task 1).
//
// Two rules the design serves, in this order:
//  1. forwarding must never cost the child's own ingest — a parent that is
//     down, slow or hostile cannot turn a working /v1/events into a 500;
//  2. the identity policy is the PARENT's to set. The child applies what it is
//     told and records which policy produced each row, so a later switch
//     cannot mix identities inside one series.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { outboxDepth } from '../services/federation/federationSync';
import {
  forwardEvents, pseudonymFor, effectiveIdentityPolicy, type IdentityPolicy,
} from '../services/federation/forwarding';

const SECRET = 'a'.repeat(64);
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

const ev = (id: string, userKey = 'alice@acme.com') => ({
  eventId: id, type: 'item.closed', userKey, occurredAt: '2026-09-14T10:00:00.000Z',
  installationId: 'i1', payload: { a: 1 },
});

let db: HubDb;
beforeEach(async () => { db = await openDb(':memory:'); });

describe('effectiveIdentityPolicy', () => {
  it('defaults to keeping real identities', () => {
    expect(effectiveIdentityPolicy(null, null)).toBe('keep');
  });

  it('lets the group default apply when a child has no setting of its own', () => {
    expect(effectiveIdentityPolicy('pseudonymize', null)).toBe('pseudonymize');
    expect(effectiveIdentityPolicy('keep', null)).toBe('keep');
  });

  it('lets a per-child setting override the group default, in both directions', () => {
    expect(effectiveIdentityPolicy('pseudonymize', 'keep')).toBe('keep');
    expect(effectiveIdentityPolicy('keep', 'pseudonymize')).toBe('pseudonymize');
  });

  it('treats an unrecognised value as the default rather than guessing', () => {
    expect(effectiveIdentityPolicy('nonsense' as IdentityPolicy, null)).toBe('keep');
    expect(effectiveIdentityPolicy(null, 'nonsense' as IdentityPolicy)).toBe('keep');
  });
});

describe('pseudonymFor', () => {
  it('is stable for the same person on the same child hub', () => {
    expect(pseudonymFor('ch-1', SECRET, 'alice@acme.com')).toBe(pseudonymFor('ch-1', SECRET, 'alice@acme.com'));
  });

  it('differs between people', () => {
    expect(pseudonymFor('ch-1', SECRET, 'alice@acme.com')).not.toBe(pseudonymFor('ch-1', SECRET, 'bob@acme.com'));
  });

  it('differs between child hubs, so the parent cannot join one person across them', () => {
    expect(pseudonymFor('ch-1', SECRET, 'alice@acme.com')).not.toBe(pseudonymFor('ch-2', SECRET, 'alice@acme.com'));
  });

  it('does not contain the original identity', () => {
    const p = pseudonymFor('ch-1', SECRET, 'alice@acme.com');
    expect(p).not.toContain('alice');
    expect(p).not.toContain('acme');
    expect(p).toMatch(/^anon:[0-9a-f]{16}$/);
  });
});

describe('forwardEvents', () => {
  it('queues nothing on a hub with no parent', async () => {
    const out = await forwardEvents(db, SECRET, [ev('e1')]);
    expect(out.forwarded).toBe(0);
    expect(await outboxDepth(db)).toBe(0);
  });

  it('queues each event once the hub is bound', async () => {
    await writeParentBinding(db, SECRET, binding);
    const out = await forwardEvents(db, SECRET, [ev('e1'), ev('e2')]);
    expect(out.forwarded).toBe(2);
    expect(await outboxDepth(db)).toBe(2);
  });

  it('does not even try to queue once the parent has released the hub', async () => {
    // enqueueOutbox refuses a revoked binding too, so "nothing was queued"
    // alone cannot tell which layer refused. `failed: 0` says this one did:
    // had it tried and been turned away downstream, the event would count as
    // a failure rather than never having been offered.
    await writeParentBinding(db, SECRET, { ...binding, state: 'revoked' });
    const out = await forwardEvents(db, SECRET, [ev('e1')]);
    expect(out).toMatchObject({ forwarded: 0, failed: 0 });
    expect(await outboxDepth(db)).toBe(0);
  });

  it('keeps the real identity by default, and says which policy produced the row', async () => {
    await writeParentBinding(db, SECRET, binding);
    await forwardEvents(db, SECRET, [ev('e1')]);
    const row = await db.get<any>('SELECT payload FROM federation_outbox');
    const p = JSON.parse(row.payload);
    expect(p.event.userKey).toBe('alice@acme.com');
    expect(p.identityPolicy).toBe('keep');
    expect(p.childHubId).toBe('ch-1');
  });

  it('pseudonymises when the parent says to, and stamps that on the row', async () => {
    await writeParentBinding(db, SECRET, { ...binding, identityPolicy: 'pseudonymize' } as any);
    await forwardEvents(db, SECRET, [ev('e1')]);
    const row = await db.get<any>('SELECT payload FROM federation_outbox');
    const p = JSON.parse(row.payload);
    expect(p.event.userKey).toBe(pseudonymFor('ch-1', SECRET, 'alice@acme.com'));
    expect(p.event.userKey).not.toContain('alice');
    expect(p.identityPolicy).toBe('pseudonymize');
  });

  it('does not rewrite rows that were already queued when the policy changed', async () => {
    // Otherwise one series would silently contain two different identity
    // spaces for the same person.
    await writeParentBinding(db, SECRET, binding);
    await forwardEvents(db, SECRET, [ev('e1')]);
    await writeParentBinding(db, SECRET, { ...binding, identityPolicy: 'pseudonymize' } as any);
    await forwardEvents(db, SECRET, [ev('e2')]);
    const rows = await db.all<any>('SELECT payload FROM federation_outbox ORDER BY seq ASC');
    const parsed = rows.map((r: any) => JSON.parse(r.payload));
    expect(parsed[0].identityPolicy).toBe('keep');
    expect(parsed[0].event.userKey).toBe('alice@acme.com');
    expect(parsed[1].identityPolicy).toBe('pseudonymize');
    expect(parsed[1].event.userKey).not.toBe('alice@acme.com');
  });

  it('never throws, whatever the events look like', async () => {
    await writeParentBinding(db, SECRET, binding);
    const circular: any = { ...ev('e1') }; circular.payload = { self: circular };
    await expect(forwardEvents(db, SECRET, [circular])).resolves.toMatchObject({ forwarded: 0 });
    await expect(forwardEvents(db, SECRET, [null as any])).resolves.toBeDefined();
    await expect(forwardEvents(db, SECRET, [])).resolves.toMatchObject({ forwarded: 0 });
  });

  it('reports a database failure instead of propagating it into the caller', async () => {
    await writeParentBinding(db, SECRET, binding);
    const real = db.run.bind(db);
    (db as any).run = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO federation_outbox/i.test(sql)) throw new Error('disk full');
      return real(sql, params);
    };
    const out = await forwardEvents(db, SECRET, [ev('e1')]);
    (db as any).run = real;
    expect(out.forwarded).toBe(0);
    expect(out.failed).toBe(1);
  });
});
