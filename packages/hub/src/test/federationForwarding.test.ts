import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { outboxDepth } from '../services/federation/federationSync';
import {
  forwardEvents, pseudonymFor, redactIdentity, FORWARDABLE_PAYLOAD_KEYS,
} from '../services/federation/forwarding';
import {
  effectiveIdentityCoding, AS_WRITTEN, type IdentityCoding,
} from '../services/federation/identityCoding';

const SECRET = 'a'.repeat(64);
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

const PERSON: IdentityCoding = { person: 'coded', installation: 'as-written' };
const INSTALLATION: IdentityCoding = { person: 'as-written', installation: 'coded' };
const BOTH: IdentityCoding = { person: 'coded', installation: 'coded' };

const ev = (id: string, userKey = 'alice@acme.com') => ({
  eventId: id, type: 'item.closed', userKey, occurredAt: '2026-09-14T10:00:00.000Z',
  installationId: 'i1', payload: { a: 1 },
});

let db: HubDb;
beforeEach(async () => { db = await openDb(':memory:'); });

describe('effectiveIdentityCoding', () => {
  it('sends both fields as written when nothing is set', () => {
    expect(effectiveIdentityCoding(null, null)).toEqual({ person: 'as-written', installation: 'as-written' });
    expect(AS_WRITTEN).toEqual({ person: 'as-written', installation: 'as-written' });
  });

  it('applies the group default per field when a child has no setting of its own', () => {
    expect(effectiveIdentityCoding({ person: 'coded', installation: null }, null)).toEqual(PERSON);
    expect(effectiveIdentityCoding({ person: null, installation: 'coded' }, { person: null, installation: null })).toEqual(INSTALLATION);
  });

  it('lets a per-child setting override the group default field by field, in both directions', () => {
    expect(effectiveIdentityCoding(BOTH, { person: 'as-written', installation: null })).toEqual(INSTALLATION);
    expect(effectiveIdentityCoding({ person: 'as-written', installation: 'as-written' }, { person: null, installation: 'coded' })).toEqual(INSTALLATION);
    expect(effectiveIdentityCoding(PERSON, { person: 'as-written', installation: 'coded' })).toEqual(INSTALLATION);
  });

  it('skips an unrecognised value rather than guessing, falling back to the group and then to as written', () => {
    expect(effectiveIdentityCoding({ person: 'pseudonymize', installation: 'coded' } as any, null)).toEqual(INSTALLATION);
    expect(effectiveIdentityCoding({ person: 'coded', installation: 'coded' }, { person: 'keep', installation: 7 } as any)).toEqual(BOTH);
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

  it('depends on the child\'s own secret, not just on ids the parent already knows', () => {
    // The parent ISSUED childHubId, and the input space is a company's email
    // addresses. Keyed on the hub id alone, every pseudonym falls to a
    // dictionary attack in milliseconds.
    const OTHER = 'b'.repeat(64);
    expect(pseudonymFor('ch-1', SECRET, 'alice@acme.com')).not.toBe(pseudonymFor('ch-1', OTHER, 'alice@acme.com'));
  });

  it('does not contain the original identity', () => {
    const p = pseudonymFor('ch-1', SECRET, 'alice@acme.com');
    expect(p).not.toContain('alice');
    expect(p).not.toContain('acme');
    expect(p).toMatch(/^anon:[0-9a-f]{16}$/);
  });
});

describe('redactIdentity', () => {
  const full = {
    eventId: 'e1', orgId: 'org', type: 'pr.opened', occurredAt: '2026-09-14T10:00:00.000Z',
    installationId: 'i1', userKey: 'alice@acme.com',
    actor: { osUser: 'alice', gitName: 'Alice Smith', gitEmail: 'alice@acme.com' },
    itemTitle: 'Fix alice@acme.com login', remoteUrl: 'https://github.com/acme/app',
    externalId: 'ACME-7', externalUrl: 'https://acme.atlassian.net/browse/ACME-7',
    payload: { repo: 'acme/app', prNumber: 7, model: 'm', harness: 'h', author: 'alice@acme.com', branch: 'feat/alice-thing' },
  };

  it('sends the event exactly as written when no field is coded', () => {
    const out = redactIdentity(full, 'ch-1', SECRET, AS_WRITTEN);
    expect(out).toEqual(full);
  });

  it('codes the person only: user key coded, actor, title and free-form payload dropped, installation as written', () => {
    const out = redactIdentity(full, 'ch-1', SECRET, PERSON) as any;
    expect(out.userKey).toBe(pseudonymFor('ch-1', SECRET, 'alice@acme.com'));
    expect(out.actor).toBeNull();
    expect(out.itemTitle).toBeNull();
    expect(out.payload).toEqual({ repo: 'acme/app', prNumber: 7, model: 'm', harness: 'h' });
    expect(out.installationId).toBe('i1');
    const blob = JSON.stringify({ ...out, installationId: null });
    expect(blob).not.toContain('alice');
    expect(blob).not.toContain('Alice');
  });

  it('codes the installation only: the installation id coded, the person and payload as written', () => {
    const out = redactIdentity(full, 'ch-1', SECRET, INSTALLATION) as any;
    expect(out.installationId).toMatch(/^anon:[0-9a-f]{16}$/);
    expect(out.userKey).toBe('alice@acme.com');
    expect(out.actor).toEqual(full.actor);
    expect(out.itemTitle).toBe(full.itemTitle);
    expect(out.payload).toEqual(full.payload);
    expect({ ...out, installationId: 'i1' }).toEqual(full);
  });

  it('codes both: removes every trace of the person, not just the user key, and the installation', () => {
    // Rewriting userKey alone was cosmetic: userKeyFor DERIVES that key from
    // actor.gitEmail, so the parent could recompute the plaintext from the
    // very row that claimed to be anonymous.
    const out = redactIdentity(full, 'ch-1', SECRET, BOTH);
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('alice');
    expect(blob).not.toContain('Alice');
    expect(blob).not.toContain('i1');
    expect(out.actor).toBeNull();
    expect(out.itemTitle).toBeNull();
    expect(out.userKey).toMatch(/^anon:[0-9a-f]{16}$/);
  });

  it('codes the installation id per child hub, so it cannot rejoin one machine across hubs', () => {
    const a = redactIdentity(full, 'ch-1', SECRET, INSTALLATION);
    const b = redactIdentity(full, 'ch-2', SECRET, INSTALLATION);
    expect(a.installationId).not.toBe('i1');
    expect(a.installationId).not.toBe(b.installationId);
    expect(redactIdentity(full, 'ch-1', SECRET, BOTH).installationId).toBe(a.installationId);
  });

  it('keeps only the payload keys the parent aggregates when the person is coded, dropping the rest', () => {
    const out = redactIdentity(full, 'ch-1', SECRET, BOTH) as any;
    expect(out.payload).toEqual({ repo: 'acme/app', prNumber: 7, model: 'm', harness: 'h' });
    expect(Object.keys(out.payload).every(k => (FORWARDABLE_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('keeps the repository and the ticket whatever is coded, because neither is a person', () => {
    for (const coding of [PERSON, INSTALLATION, BOTH]) {
      const out = redactIdentity(full, 'ch-1', SECRET, coding) as any;
      expect(out.remoteUrl).toBe('https://github.com/acme/app');
      expect(out.externalId).toBe('ACME-7');
      expect(out.externalUrl).toBe('https://acme.atlassian.net/browse/ACME-7');
    }
  });

  it('keeps a no-card usage total countable, as its day, time and token numbers only (GH-394)', () => {
    const out = redactIdentity({
      ...full, type: 'usage.no-card',
      payload: {
        day: '2026-11-19', asOf: '2026-11-19T18:00:00.000Z', flow: { name: 'secret flow' },
        usage: { total: { turns: 2, input: 40, costUsd: '0.5', note: 'alice@acme.com' },
          byModel: [{ client: 'pi', model: 'qwen3.8:27b', turns: 2, input: 40, costUsd: 0.5, who: 'alice@acme.com' }] },
      },
    }, 'ch-1', SECRET, BOTH) as any;
    expect(out.payload.day).toBe('2026-11-19');
    expect(out.payload.asOf).toBe('2026-11-19T18:00:00.000Z');
    expect(out.payload.usage.total).toMatchObject({ turns: 2, input: 40, costUsd: 0.5, output: 0 });
    expect(out.payload.usage.byModel).toEqual([expect.objectContaining({ client: 'pi', model: 'qwen3.8:27b', input: 40 })]);
    expect(JSON.stringify(out.payload)).not.toContain('alice');
    expect(JSON.stringify(out.payload)).not.toContain('secret flow');
  });

  const m = (over: Record<string, unknown> = {}) => ({
    client: 'claude-code', model: 'claude-opus-5-5', turns: 3, input: 10, cacheRead: 900, cacheWrite: 50,
    output: 20, reasoning: 0, costUsd: 0, unpricedTurns: 3, who: 'alice@acme.com', ...over,
  });
  const t = (over: Record<string, unknown> = {}) => ({
    turns: 3, input: 10, cacheRead: 900, cacheWrite: 50, output: 20, reasoning: 0, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 3, ...over,
  });

  it('keeps a step change countable when the person is coded: its usage numbers, own snapshot and step, no identity (GH-395)', () => {
    const out = redactIdentity({
      ...full, type: 'step.transitioned',
      payload: {
        fromStatus: 'IN_PROGRESS', toStatus: 'REVIEW',
        usage: {
          step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: '2026-11-19T10:00:00.000Z', leftAt: '2026-11-19T11:00:00.000Z',
          complete: false, byModel: [m()], total: { ...t(), note: 'alice@acme.com' },
          own: { asOf: '2026-11-19T11:00:00.000Z', byModel: [m()], total: t(), sessionFile: '/Users/alice/.claude/x.jsonl' },
          sessions: [{ id: 'alice-session' }],
        },
      },
    }, 'ch-1', SECRET, PERSON) as any;
    const u = out.payload.usage;
    expect(out.payload.toStatus).toBe('REVIEW');
    expect(u.step).toBe('IN_PROGRESS');
    expect(u.to).toBe('REVIEW');
    expect(u.enteredAt).toBe('2026-11-19T10:00:00.000Z');
    expect(u.leftAt).toBe('2026-11-19T11:00:00.000Z');
    expect(u.complete).toBe(false);
    expect(u.total).toEqual(t());
    expect(u.byModel).toEqual([{ ...t(), client: 'claude-code', model: 'claude-opus-5-5' }]);
    expect(u.own).toEqual({ asOf: '2026-11-19T11:00:00.000Z', byModel: [{ ...t(), client: 'claude-code', model: 'claude-opus-5-5' }], total: t() });
    expect(u.sessions).toBeUndefined();
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('alice');
    expect(blob).not.toContain('acme.com');
  });

  it('keeps a close countable when the person is coded: total, own, cards and the steps, no identity (GH-395)', () => {
    const out = redactIdentity({
      ...full, type: 'item.closed',
      payload: {
        usage: {
          cards: 4, complete: true, byModel: [m({ costUsd: '0.25' })], total: t({ costUsd: 0.25 }),
          byStep: [{ step: 'IN_PROGRESS', total: t(), owner: 'alice@acme.com' }, { step: 'REVIEW', total: t({ turns: 1 }) }],
          own: { asOf: '2026-11-19T12:00:00.000Z', byModel: [m()], total: t() },
        },
      },
    }, 'ch-1', SECRET, BOTH) as any;
    const u = out.payload.usage;
    expect(u.cards).toBe(4);
    expect(u.complete).toBe(true);
    expect(u.byModel[0].costUsd).toBe(0.25);
    expect(u.total.costUsd).toBe(0.25);
    expect(u.byStep).toEqual([{ step: 'IN_PROGRESS', total: t() }, { step: 'REVIEW', total: t({ turns: 1 }) }]);
    expect(u.own.asOf).toBe('2026-11-19T12:00:00.000Z');
    expect(JSON.stringify(out)).not.toContain('alice');
  });

  it('keeps the usage untouched when only the installation is coded (GH-395)', () => {
    const usage = { step: 'IN_PROGRESS', enteredAt: 'Thu, 19 Nov 2026 10:00:00 GMT', byModel: [m()], total: t(), sessions: [{ id: 's' }] };
    const out = redactIdentity({ ...full, type: 'step.transitioned', payload: { usage } }, 'ch-1', SECRET, INSTALLATION) as any;
    expect(out.payload.usage).toEqual(usage);
  });

  it('sends model, harness and step names as written, whatever is coded (GH-395)', () => {
    const odd = { model: '/Users/alice/models/custom.gguf', client: 'alice-harness', step: 'Review by alice' };
    const out = (redactIdentity({
      ...full, type: 'item.closed',
      payload: { usage: {
        step: odd.step, to: odd.step, byModel: [m({ model: odd.model, client: odd.client })], total: t(),
        byStep: [{ step: odd.step, total: t() }], own: { byModel: [m({ model: odd.model, client: odd.client })], total: t() },
      } },
    }, 'ch-1', SECRET, BOTH) as any).payload.usage;
    expect(out.step).toBe(odd.step);
    expect(out.to).toBe(odd.step);
    expect(out.byStep[0].step).toBe(odd.step);
    for (const row of [out.byModel[0], out.own.byModel[0]]) {
      expect(row.model).toBe(odd.model);
      expect(row.client).toBe(odd.client);
    }
    const noCard = (redactIdentity({
      ...full, type: 'usage.no-card',
      payload: { day: '2026-11-19', usage: { total: t(), byModel: [m({ model: odd.model, client: odd.client })] } },
    }, 'ch-1', SECRET, BOTH) as any).payload.usage.byModel[0];
    expect(noCard).toMatchObject({ model: odd.model, client: odd.client });
  });

  it('re-serialises a parseable non-ISO time to ISO, dropping text riding in it, when the person is coded (GH-395)', () => {
    const sneaky = 'Thu, 19 Nov 2026 10:00:00 GMT (alice@acme.com)';
    const out = redactIdentity({
      ...full, type: 'step.transitioned',
      payload: { usage: { enteredAt: sneaky, leftAt: '2026-11-19T11:00:00-03:00', byModel: [], total: t(), own: { asOf: sneaky, byModel: [], total: t() } } },
    }, 'ch-1', SECRET, PERSON) as any;
    expect(out.payload.usage.enteredAt).toBe('2026-11-19T10:00:00.000Z');
    expect(out.payload.usage.own.asOf).toBe('2026-11-19T10:00:00.000Z');
    expect(out.payload.usage.leftAt).toBe('2026-11-19T14:00:00.000Z');
    expect(JSON.stringify(out)).not.toContain('alice');
  });

  it('drops a time that does not parse at all, when the person is coded (GH-395)', () => {
    const out = redactIdentity({
      ...full, type: 'step.transitioned',
      payload: { usage: { enteredAt: 'alice@acme.com', leftAt: 42, byModel: [], total: t(), own: { asOf: 'soon, says alice', byModel: [], total: t() } } },
    }, 'ch-1', SECRET, PERSON) as any;
    expect(out.payload.usage.enteredAt).toBeUndefined();
    expect(out.payload.usage.leftAt).toBeUndefined();
    expect(out.payload.usage.own.asOf).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('alice');
  });

  it('keeps a no-card day only as a date, and re-serialises its time to ISO, when the person is coded (GH-395)', () => {
    const out = (day: string, asOf: string) => (redactIdentity({
      ...full, type: 'usage.no-card', payload: { day, asOf, usage: { total: t(), byModel: [] } },
    }, 'ch-1', SECRET, PERSON) as any).payload;
    expect(out('2026-11-19', '2026-11-19T18:00:00.000Z')).toMatchObject({ day: '2026-11-19', asOf: '2026-11-19T18:00:00.000Z' });
    const bad = out('2026-11-19 alice@acme.com', 'Thu, 19 Nov 2026 18:00:00 GMT (alice@acme.com)');
    expect(bad.day).toBeUndefined();
    expect(bad.asOf).toBe('2026-11-19T18:00:00.000Z');
    expect(JSON.stringify(bad)).not.toContain('alice');
  });

  it('forwards no usage when the event had none, rather than an empty one (GH-395)', () => {
    const out = redactIdentity({ ...full, type: 'step.transitioned', payload: { toStatus: 'REVIEW' } }, 'ch-1', SECRET, PERSON) as any;
    expect(out.payload).toEqual({ toStatus: 'REVIEW' });
  });

  it.each([['the person', PERSON], ['the person and the installation', BOTH], ['the installation', INSTALLATION]] as const)(
    'GH-395 x GH-397: with %s coded, a step and a close keep the stored estimate on total, byModel, own and byStep', (_name, coding) => {
      const est = (v: number) => ({ estimatedCostUsd: v, unpricedTurns: 0 });
      const step = (redactIdentity({
        ...full, type: 'step.transitioned',
        payload: { toStatus: 'REVIEW', usage: {
          step: 'IN_PROGRESS', byModel: [m(est(0.75))], total: t(est(0.75)),
          own: { asOf: '2026-11-19T11:00:00.000Z', byModel: [m(est(0.5))], total: t(est(0.5)) },
        } },
      }, 'ch-1', SECRET, coding) as any).payload.usage;
      expect(step.total.estimatedCostUsd).toBe(0.75);
      expect(step.byModel[0].estimatedCostUsd).toBe(0.75);
      expect(step.own.total.estimatedCostUsd).toBe(0.5);
      expect(step.own.byModel[0].estimatedCostUsd).toBe(0.5);
      const close = (redactIdentity({
        ...full, type: 'item.closed',
        payload: { usage: {
          cards: 2, byModel: [m(est(1.25))], total: t(est(1.25)),
          byStep: [{ step: 'IN_PROGRESS', total: t(est(1)) }, { step: 'REVIEW', total: t(est(0.25)) }],
          own: { asOf: '2026-11-19T12:00:00.000Z', byModel: [m(est(1))], total: t(est(1)) },
        } },
      }, 'ch-1', SECRET, coding) as any).payload.usage;
      expect(close.total.estimatedCostUsd).toBe(1.25);
      expect(close.byModel[0].estimatedCostUsd).toBe(1.25);
      expect(close.byStep.map((s: any) => s.total.estimatedCostUsd)).toEqual([1, 0.25]);
      expect(close.own.total.estimatedCostUsd).toBe(1);
      expect(close.own.byModel[0].estimatedCostUsd).toBe(1);
      const noCard = (redactIdentity({
        ...full, type: 'usage.no-card',
        payload: { day: '2026-11-19', asOf: '2026-11-19T18:00:00.000Z', usage: { total: t(est(0.3)), byModel: [m(est(0.3))] } },
      }, 'ch-1', SECRET, coding) as any).payload.usage;
      expect(noCard.total.estimatedCostUsd).toBe(0.3);
      expect(noCard.byModel[0].estimatedCostUsd).toBe(0.3);
    });

  it('GH-397: a no-card total keeps the cost AgEnFK estimated when the turns were used, and an older one without it forwards zero', () => {
    const fwd = (usage: unknown) => (redactIdentity({ ...full, type: 'usage.no-card', payload: { day: '2026-11-19', asOf: 'x', usage } }, 'ch-1', SECRET, PERSON) as any).payload.usage;
    const now = fwd({ total: { turns: 2, estimatedCostUsd: '0.75' }, byModel: [{ client: 'claude-code', model: 'claude-opus-5-5', turns: 2, estimatedCostUsd: 0.75 }] });
    expect(now.total.estimatedCostUsd).toBe(0.75);
    expect(now.byModel[0].estimatedCostUsd).toBe(0.75);
    const older = fwd({ total: { turns: 1 }, byModel: [{ client: 'pi', model: 'q', turns: 1 }] });
    expect(older.total.estimatedCostUsd).toBe(0);
  });

  it('survives an event with no identity at all', () => {
    const out = redactIdentity({ eventId: 'e', type: 't' }, 'ch-1', SECRET, BOTH);
    expect(out.userKey).toBeNull();
    expect(out.payload).toEqual({});
    expect(out.installationId).toBe('anon:unknown');
  });

  it('does not collapse everyone without a user key onto one pseudonym', () => {
    const a = redactIdentity({ ...full, userKey: undefined }, 'ch-1', SECRET, PERSON);
    expect(a.userKey).toBeNull();
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

  it('sends everything as written by default, and stamps the coding on the row', async () => {
    await writeParentBinding(db, SECRET, binding);
    const out = await forwardEvents(db, SECRET, [ev('e1')]);
    expect(out.coding).toEqual(AS_WRITTEN);
    const row = await db.get<any>('SELECT payload FROM federation_outbox');
    const p = JSON.parse(row.payload);
    expect(p.event).toEqual(ev('e1'));
    expect(p.identity).toEqual(AS_WRITTEN);
    expect(p.identityPolicy).toBe('keep');
    expect(p.childHubId).toBe('ch-1');
  });

  it('codes the fields the parent says to, and stamps that on the row', async () => {
    await writeParentBinding(db, SECRET, { ...binding, identity: PERSON });
    await forwardEvents(db, SECRET, [ev('e1')]);
    const row = await db.get<any>('SELECT payload FROM federation_outbox');
    const p = JSON.parse(row.payload);
    expect(p.event.userKey).toBe(pseudonymFor('ch-1', SECRET, 'alice@acme.com'));
    expect(p.event.installationId).toBe('i1');
    expect(p.identity).toEqual(PERSON);
    expect(p.identityPolicy).toBe('pseudonymize');
  });

  it('codes only the installation when that is all the parent asks for', async () => {
    await writeParentBinding(db, SECRET, { ...binding, identity: INSTALLATION });
    await forwardEvents(db, SECRET, [ev('e1')]);
    const p = JSON.parse((await db.get<any>('SELECT payload FROM federation_outbox')).payload);
    expect(p.event.userKey).toBe('alice@acme.com');
    expect(p.event.payload).toEqual({ a: 1 });
    expect(p.event.installationId).toMatch(/^anon:[0-9a-f]{16}$/);
    expect(p.identity).toEqual(INSTALLATION);
    expect(p.identityPolicy).toBe('pseudonymize');
  });

  it('does not rewrite rows that were already queued when the coding changed', async () => {
    // Otherwise one series would silently contain two different identity
    // spaces for the same person.
    await writeParentBinding(db, SECRET, binding);
    await forwardEvents(db, SECRET, [ev('e1')]);
    await writeParentBinding(db, SECRET, { ...binding, identity: BOTH });
    await forwardEvents(db, SECRET, [ev('e2')]);
    await writeParentBinding(db, SECRET, { ...binding, identity: AS_WRITTEN });
    const rows = await db.all<any>('SELECT payload FROM federation_outbox ORDER BY seq ASC');
    const parsed = rows.map((r: any) => JSON.parse(r.payload));
    expect(parsed[0].identity).toEqual(AS_WRITTEN);
    expect(parsed[0].event.userKey).toBe('alice@acme.com');
    expect(parsed[1].identity).toEqual(BOTH);
    expect(parsed[1].event.userKey).not.toBe('alice@acme.com');
    expect(parsed[1].event.installationId).not.toBe('i1');
  });

  it('lets one bad event fail without costing the good ones beside it', async () => {
    await writeParentBinding(db, SECRET, binding);
    const circular: any = { ...ev('bad') }; circular.payload = { self: circular };
    const out = await forwardEvents(db, SECRET, [circular, ev('good')]);
    expect(out).toMatchObject({ forwarded: 1, failed: 1 });
    expect(await outboxDepth(db)).toBe(1);
    const row = await db.get<any>('SELECT payload FROM federation_outbox');
    expect(JSON.parse(row.payload).event.eventId).toBe('good');
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
