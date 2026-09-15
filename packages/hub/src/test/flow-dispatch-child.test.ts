// The child side of flow dispatch (CGLAB-182, task 2).
//
// A child hub pulls a flow.dispatch directive and installs the flow its parent
// sent, marked as parent-origin and available to the org.
//
// The decisions under test, all confirmed with the user:
//  - a name clash with a flow the CHILD authored installs ALONGSIDE it; flows
//    are keyed by id and nothing local is ever overwritten;
//  - redelivery is a no-op (delivery is at-least-once, so this happens);
//  - a version bump re-installs over the same flow id, rather than piling up
//    copies of the same flow.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { federationTick } from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const ORG = 'org';
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

const dispatch = (over: Record<string, unknown> = {}) => ({
  kind: 'flow.dispatch',
  dispatchId: 'd-1',
  flowVersion: 1,
  flow: {
    id: 'flow-parent-1',
    name: 'Group TDD',
    description: 'the org standard',
    version: 1,
    definition: {
      name: 'Group TDD',
      steps: [{ id: 'todo', name: 'TODO', order: 0 }, { id: 'done', name: 'DONE', order: 1 }],
    },
  },
  ...over,
});

function transport(directive: unknown) {
  let served = directive;
  return {
    async ping() { return { ok: true }; },
    async directives() { return served; },
    async deliver(rows: any[]) { return { accepted: rows.length }; },
    serve(next: unknown) { served = next; },
  };
}

let db: HubDb;
const tick = (t: any) => federationTick({ db, secretKey: SECRET, transport: t, orgId: ORG } as any);
const flows = () => db.all<any>('SELECT id, org_id, name, source, version, org_available FROM flows ORDER BY name, id');

beforeEach(async () => {
  db = await openDb(':memory:');
  await writeParentBinding(db, SECRET, binding);
});

describe('a child installs the flow its parent dispatched', () => {
  it('stores it as a parent-origin flow, available to the org', async () => {
    const out = await tick(transport(dispatch()));
    expect(out.ok).toBe(true);
    const rows = await flows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'flow-parent-1', org_id: ORG, name: 'Group TDD', source: 'parent', version: 1,
    });
    // Dispatched flows are for the whole org to pick up — that is the point.
    expect(Number(rows[0].org_available)).toBe(1);
  });

  it('keeps the steps intact, so the child can actually run it', async () => {
    await tick(transport(dispatch()));
    const row = await db.get<any>('SELECT definition_json FROM flows WHERE id = ?', ['flow-parent-1']);
    expect(JSON.parse(row.definition_json).steps.map((s: any) => s.name)).toEqual(['TODO', 'DONE']);
  });

  it('installs once when the same dispatch arrives twice', async () => {
    // Delivery is at-least-once by design, so this is a normal event.
    const t = transport(dispatch());
    await tick(t);
    await tick(t);
    expect(await flows()).toHaveLength(1);
  });

  it('re-installs over the same flow when the parent bumps the version', async () => {
    const t = transport(dispatch());
    await tick(t);
    t.serve(dispatch({
      dispatchId: 'd-2',
      flowVersion: 2,
      flow: {
        id: 'flow-parent-1', name: 'Group TDD v2', description: null, version: 2,
        definition: { name: 'Group TDD v2', steps: [{ id: 'a', name: 'A', order: 0 }] },
      },
    }));
    await tick(t);
    const rows = await flows();
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]).toMatchObject({ name: 'Group TDD v2', version: 2 });
  });

  it('never goes backwards if an older dispatch is redelivered late', async () => {
    const t = transport(dispatch({ flowVersion: 2, flow: { ...dispatch().flow, version: 2, name: 'v2' } }));
    await tick(t);
    t.serve(dispatch({ flowVersion: 1, flow: { ...dispatch().flow, version: 1, name: 'v1' } }));
    await tick(t);
    const rows = await flows();
    expect(rows[0]).toMatchObject({ name: 'v2', version: 2 });
  });
});

describe('what the child already had is never touched', () => {
  it('installs alongside a local flow of the same name', async () => {
    await db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, ?, 'hub', 3, 0)`,
      ['local-1', ORG, 'Group TDD', 'ours, authored here',
       JSON.stringify({ name: 'Group TDD', steps: [{ id: 'x', name: 'X', order: 0 }] })],
    );
    await tick(transport(dispatch()));

    const rows = await flows();
    expect(rows).toHaveLength(2);
    const local = rows.find((r: any) => r.id === 'local-1');
    // Untouched: same source, same version, same availability.
    expect(local).toMatchObject({ source: 'hub', version: 3, name: 'Group TDD' });
    expect(Number(local.org_available)).toBe(0);
    expect(rows.find((r: any) => r.id === 'flow-parent-1')).toMatchObject({ source: 'parent' });
  });

  it('leaves a hub with no parent completely alone', async () => {
    const fresh = await openDb(':memory:');
    const out = await federationTick({ db: fresh, secretKey: SECRET, transport: transport(dispatch()), orgId: ORG } as any);
    expect(out.skipped).toBe('no-binding');
    expect(await fresh.all('SELECT id FROM flows')).toEqual([]);
  });
});

describe('a flow that was unlocked and is dispatched again', () => {
  // Detaching a child unlocks its parent-origin flows into ordinary local ones
  // (task f71d028a). If that hub later re-joins and the flow is re-dispatched,
  // the row already exists as a local, possibly-unavailable flow — the update
  // has to put it back under the parent's control, not just change its name.
  const relocked = async () => {
    await db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, ?, 'hub', 1, 0)`,
      ['flow-parent-1', ORG, 'Group TDD', null,
       JSON.stringify({ name: 'Group TDD', steps: [{ id: 'x', name: 'X', order: 0 }] })],
    );
    await tick(transport(dispatch({
      flowVersion: 2,
      flow: { ...dispatch().flow, version: 2, name: 'Group TDD v2' },
    })));
    return db.get<any>('SELECT source, org_available, name FROM flows WHERE id = ?', ['flow-parent-1']);
  };

  it('is marked parent-origin again', async () => {
    expect((await relocked()).source).toBe('parent');
  });

  it('does NOT re-publish it to the org behind the admin\'s back', async () => {
    // This used to assert the opposite. Which flows this hub offers its teams
    // is the child's choice — that is exactly why the availability toggle is
    // left unlocked on a parent-origin flow — so an admin who took it out of
    // the picker must not find it back there because the parent bumped a
    // version. A flow arriving for the FIRST time is still published; only an
    // existing row's choice is respected.
    expect(Number((await relocked()).org_available)).toBe(0);
  });

  it('reclaims a locally-edited flow WITHOUT walking its content backwards', async () => {
    // The realistic re-join: the flow was released on detach, the child edited
    // it, and its version climbed past the parent's. Re-locking must return
    // ownership without silently rolling the content back — the guard that
    // makes a reclaim possible is not a licence to regress.
    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, 'hub', 7, 1)`,
      ['flow-parent-1', ORG, 'Local edits',
       JSON.stringify({ name: 'Local edits', steps: [{ id: 'a', name: 'A', order: 0 }] })],
    );
    await tick(transport(dispatch({ flowVersion: 2, flow: { ...dispatch().flow, version: 2 } })));

    const row = await db.get<any>('SELECT source, name, version FROM flows WHERE id = ?', ['flow-parent-1']);
    expect(row.source).toBe('parent');
    expect(row.name).toBe('Local edits');
    expect(Number(row.version)).toBe(7);
  });

  it('and a genuinely newer parent version still wins', async () => {
    await db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, 'hub', 7, 1)`,
      ['flow-parent-1', ORG, 'Local edits',
       JSON.stringify({ name: 'Local edits', steps: [{ id: 'a', name: 'A', order: 0 }] })],
    );
    await tick(transport(dispatch({ flowVersion: 9, flow: { ...dispatch().flow, version: 9, name: 'Group TDD v9' } })));

    const row = await db.get<any>('SELECT source, name, version FROM flows WHERE id = ?', ['flow-parent-1']);
    expect(row.name).toBe('Group TDD v9');
    expect(Number(row.version)).toBe(9);
    expect(row.source).toBe('parent');
  });
});

describe('a definition the parent sent that this hub cannot use', () => {
  it('is refused, not installed — the parent is a different hub', async () => {
    // A definition gets the same structural check this hub applies to its own
    // admins' input. Without it a buggy parent puts a flow with no steps in
    // front of every installation, and the child reports it installed.
    for (const [i, bad] of [{}, [], { name: 'x' }, { name: 'x', steps: [] }, { name: 'x', steps: [{ id: 'a' }] }].entries()) {
      const out = await tick(transport(dispatch({
        dispatchId: `bad-${i}`,
        flow: { id: `bad-flow-${i}`, name: 'X', version: 1, definition: bad },
      })));
      expect(out.ok, JSON.stringify(bad)).toBe(true);
    }
    expect(await db.all<any>("SELECT id FROM flows WHERE source = 'parent'")).toHaveLength(0);
  });
});

describe('a directive this build cannot use', () => {
  it('is recorded, not thrown — an older child under a newer parent keeps working', async () => {
    const out = await tick(transport({ kind: 'something.new', payload: {} }));
    expect(out.ok).toBe(true);
    expect(out.unknownDirectiveKind).toBe('something.new');
    expect(await flows()).toEqual([]);
  });

  for (const [label, flow] of [
    ['no flow at all', undefined],
    ['no id', { name: 'X', definition: { steps: [] } }],
    ['no name', { id: 'f1', definition: { steps: [] } }],
    ['a definition that is not an object', { id: 'f1', name: 'X', definition: 'steps go here' }],
  ] as Array<[string, unknown]>) {
    it(`survives a flow.dispatch with ${label}, without taking the tick down`, async () => {
      // A child that throws on one bad directive stops draining its outbox too,
      // so it stops delivering anything at all — the failure spreads.
      const out = await tick(transport({ kind: 'flow.dispatch', dispatchId: 'd-9', flow }));
      expect(out.ok).toBe(true);
      expect(await flows()).toEqual([]);
    });
  }
});
