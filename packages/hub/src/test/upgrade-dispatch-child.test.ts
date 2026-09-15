// The child side of group upgrades (CGLAB-183, task 2).
//
// On pulling an `upgrade.dispatch`, the child creates a LOCAL upgrade
// directive over its OWN installations. The parent named a version; which
// machines that means is the child's question to answer, because only the
// child knows its fleet.
//
// The decision under test, confirmed with the user: an installation the child
// cannot touch is SKIPPED WITH A REASON, not a reason to fail the whole
// directive. A partial rollout is still progress, and one retired laptop must
// not block a hub. That matches what scope=all already does for a local admin,
// so the child behaves the same whether an admin or a parent asked.
//
// Out of scope, deliberately: upgrading the child hub's own Docker image.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { applyUpgradeDispatch } from '../services/federation/upgradeFanout';

const ORG = 'org';

const install = async (
  db: HubDb,
  id: string,
  over: { email?: string; version?: string | null; retired?: boolean } = {},
) => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, ORG, now, now, over.email ?? `${id}@acme.com`,
     over.version === undefined ? '1.0.0' : over.version,
     over.retired ? now : null],
  );
};

const directive = (over: Record<string, unknown> = {}) => ({
  kind: 'upgrade.dispatch',
  dispatchId: 'd-1',
  targetVersion: '1.2.3',
  confirmDowngrade: false,
  ...over,
});

let db: HubDb;
const targets = () => db.all<any>(
  `SELECT t.installation_id, t.state FROM upgrade_directive_targets t ORDER BY t.installation_id`,
);

beforeEach(async () => {
  db = await openDb(':memory:');
  await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', [ORG, ORG]);
});

describe('a child fans a group upgrade out over its own installations', () => {
  it('creates one local directive covering every eligible installation', async () => {
    await install(db, 'i1');
    await install(db, 'i2');

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(2);
    expect(out.skipped).toEqual([]);
    expect(out.outcome).toBe('applied');

    const d = await db.get<any>('SELECT * FROM upgrade_directives WHERE org_id = ?', [ORG]);
    expect(d.target_version).toBe('1.2.3');
    expect((await targets()).map(t => t.installation_id)).toEqual(['i1', 'i2']);
    expect((await targets()).every(t => t.state === 'pending')).toBe(true);
  });

  it('skips a retired installation, and says so, without losing the rest', async () => {
    await install(db, 'i1');
    await install(db, 'gone', { retired: true });

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);
    expect((await targets()).map(t => t.installation_id)).toEqual(['i1']);
  });

  it('skips a hidden person\'s machine, and says so', async () => {
    await install(db, 'i1');
    await install(db, 'departed', { email: 'Departed@Acme.com' });
    // hidden_users is keyed on the LOWERCASED git email.
    await db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', [ORG, 'departed@acme.com']);

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([{ installationId: 'departed', reason: 'hidden' }]);
  });

  it('skips an installation that is already mid-upgrade, rather than stacking a second one', async () => {
    await install(db, 'i1');
    await install(db, 'busy');
    await db.run(
      `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type) VALUES (?, ?, ?, 'all')`,
      ['prior', ORG, '1.1.0'],
    );
    await db.run(
      `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
       VALUES (?, ?, 'in_progress')`,
      ['prior', 'busy'],
    );

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([{ installationId: 'busy', reason: 'in-flight' }]);
  });

  it('refuses to move an installation backwards unless the dispatch confirmed it', async () => {
    await install(db, 'ahead', { version: '2.0.0' });
    await install(db, 'behind', { version: '1.0.0' });

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([{ installationId: 'ahead', reason: 'downgrade' }]);
  });

  it('moves it backwards when the parent admin confirmed the downgrade', async () => {
    await install(db, 'ahead', { version: '2.0.0' });

    const out = await applyUpgradeDispatch(db, ORG, directive({ confirmDowngrade: true }));

    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([]);
  });

  it('treats an installation of unknown version as upgradable, not as a downgrade', async () => {
    await install(db, 'unknown', { version: null });
    const out = await applyUpgradeDispatch(db, ORG, directive());
    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([]);
  });

  it('a hub with NOTHING to upgrade is COMPLETED, not failed', async () => {
    // A hub whose whole fleet is retired has nothing to do and has done it.
    // Reporting that as a failure would light up the parent's board red for a
    // hub behaving perfectly.
    await install(db, 'gone', { retired: true });

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(0);
    expect(out.outcome).toBe('nothing-to-do');
    expect(out.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);
    expect(await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directives')).toMatchObject({ n: 0 });
  });

  it('a hub with no installations at all is COMPLETED too', async () => {
    const out = await applyUpgradeDispatch(db, ORG, directive());
    expect(out.upgraded).toBe(0);
    expect(out.outcome).toBe('nothing-to-do');
    expect(out.skipped).toEqual([]);
  });

  it('is idempotent per dispatch — a redelivered directive does not upgrade twice', async () => {
    // Delivery is at-least-once, so this happens as a matter of course.
    await install(db, 'i1');

    const first = await applyUpgradeDispatch(db, ORG, directive());
    const second = await applyUpgradeDispatch(db, ORG, directive());

    expect(first.upgraded).toBe(1);
    // ONE directive, however many times the directive is delivered.
    expect(await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directives')).toMatchObject({ n: 1 });
    expect(await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directive_targets')).toMatchObject({ n: 1 });

    // The redelivery must be recognised AS the same dispatch, not merely come
    // out empty. Without this the in-flight skip masks a missing guard: a
    // second fan-out would find i1 already upgrading, skip it, and report
    // nothing done with no directive written — identical from the counts
    // alone, but a different thing happening. It reports what the dispatch
    // ACTUALLY did, which is the answer the parent is still waiting for.
    expect(second.outcome).toBe('already-applied');
    expect(second.directiveId).toBe(first.directiveId);
    expect(second.upgraded).toBe(1);
  });


  it('REMEMBERS what it skipped, so a redelivery reports the same fleet', async () => {
    // The skip list is what the next task reports upstream, and the parent
    // keeps re-serving a dispatch until it IS reported — so the tick that
    // reports is almost never the tick that computed. Recomputing from scratch
    // is not an option either: by then the machines it upgraded are in flight
    // and would read as skipped. The outcome has to be recorded.
    await install(db, 'i1');
    await install(db, 'gone', { retired: true });

    const first = await applyUpgradeDispatch(db, ORG, directive());
    expect(first.upgraded).toBe(1);
    expect(first.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);

    const second = await applyUpgradeDispatch(db, ORG, directive());
    expect(second.outcome).toBe('already-applied');
    expect(second.upgraded).toBe(1);
    expect(second.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);
  });

  it('remembers a nothing-to-do outcome too, without re-deriving it', async () => {
    await install(db, 'gone', { retired: true });
    const first = await applyUpgradeDispatch(db, ORG, directive());
    expect(first.outcome).toBe('nothing-to-do');

    const second = await applyUpgradeDispatch(db, ORG, directive());
    expect(second.outcome).toBe('already-applied');
    expect(second.upgraded).toBe(0);
    expect(second.skipped).toEqual([{ installationId: 'gone', reason: 'retired' }]);
  });

  it('tells a successful fan-out apart from an unusable directive', async () => {
    // These used to be the same value in the only success-shaped field the
    // report has: a clean rollout and a malformed directive both said false.
    await install(db, 'i1');
    const good = await applyUpgradeDispatch(db, ORG, directive());
    const bad = await applyUpgradeDispatch(db, ORG, directive({ dispatchId: 'd-2', targetVersion: '' }));
    expect(good.outcome).toBe('applied');
    expect(bad.outcome).toBe('invalid');
    expect(good.outcome).not.toBe(bad.outcome);
  });

  it('refuses a target version that is not a semver tag, whatever the parent said', async () => {
    // A trust boundary: the parent is a different hub. The version is
    // interpolated into a shell command far downstream on every machine in
    // this fleet, and one regex there is not somewhere to put the only check.
    await install(db, 'i1');
    for (const bad of ['latest', 'v1.2.3; rm -rf /', '$(whoami)', '../../etc', '1.2']) {
      const out = await applyUpgradeDispatch(db, ORG, directive({ dispatchId: `d-${bad}`, targetVersion: bad }));
      expect(out.outcome, bad).toBe('invalid');
    }
    expect(await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directives')).toMatchObject({ n: 0 });
  });

  it('accepts the semver shapes agenfk actually releases', async () => {
    await install(db, 'i1');
    for (const [i, ok] of ['1.2.3', 'v1.2.3', '1.2.3-beta.22'].entries()) {
      const out = await applyUpgradeDispatch(db, ORG, directive({ dispatchId: `ok-${i}`, targetVersion: ok }));
      expect(out.outcome, ok).not.toBe('invalid');
    }
  });

  it('only a real boolean confirms a downgrade', async () => {
    // Read as bare truthiness, the STRING "false" disables the guard and the
    // whole fleet rolls backwards.
    await install(db, 'ahead', { version: '2.0.0' });
    const out = await applyUpgradeDispatch(db, ORG, directive({ confirmDowngrade: 'false' } as any));
    expect(out.skipped).toEqual([{ installationId: 'ahead', reason: 'downgrade' }]);
  });

  it('does not stack a second upgrade on a machine a concurrent directive just claimed', async () => {
    // The in-flight read used to happen outside the write transaction, so a
    // local admin posting scope=all as the federation timer fired could have
    // both sides read an empty in-flight set and both insert. That is exactly
    // what the in-flight skip exists to prevent.
    await install(db, 'i1');
    const realRun = db.run.bind(db);
    let claimed = false;
    db.run = async (sql: string, params?: unknown[]) => {
      // Simulate the other writer landing between the read and the write.
      if (!claimed && /INSERT INTO upgrade_directives/i.test(sql)) {
        claimed = true;
        await realRun(
          `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type) VALUES (?, ?, ?, 'all')`,
          ['racer', ORG, '1.1.0'],
        );
        await realRun(
          `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state) VALUES (?, ?, 'pending')`,
          ['racer', 'i1'],
        );
      }
      return realRun(sql, params);
    };
    try {
      await applyUpgradeDispatch(db, ORG, directive());
    } finally {
      db.run = realRun;
    }
    const rows = await db.all<any>(
      "SELECT directive_id FROM upgrade_directive_targets WHERE installation_id = 'i1' AND state IN ('pending','in_progress')",
    );
    expect(rows).toHaveLength(1);
  });

  it('never touches another org\'s installations', async () => {
    await db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', ['other', 'other']);
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES (?, 'other', ?, ?, ?, ?)`,
      ['theirs', now, now, 'x@other.com', '1.0.0'],
    );
    await install(db, 'ours');

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.upgraded).toBe(1);
    expect((await targets()).map(t => t.installation_id)).toEqual(['ours']);
  });

  it('refuses a directive with no usable target version instead of writing a directive', async () => {
    await install(db, 'i1');
    const out = await applyUpgradeDispatch(db, ORG, directive({ targetVersion: '' }) as any);
    expect(out.error).toBeTruthy();
    expect(await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directives')).toMatchObject({ n: 0 });
  });

  it('records every skip reason when one installation could be skipped for several', async () => {
    // A retired machine belonging to a hidden person is reported once, with a
    // stable reason, rather than appearing twice in the counts.
    await install(db, 'both', { email: 'gone@acme.com', retired: true });
    await db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', [ORG, 'gone@acme.com']);

    const out = await applyUpgradeDispatch(db, ORG, directive());

    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].installationId).toBe('both');
  });
});

// The tick is what actually pulls the directive. A fan-out that works but is
// never reached is not a feature.
describe('the tick carries out an upgrade dispatch it pulls', () => {
  const SECRET = 'a'.repeat(64);

  const transport = (d: unknown) => ({
    async ping() { return { ok: true }; },
    async directives() { return d; },
    async deliver(rows: any[]) { return { accepted: rows.length }; },
  });

  it('fans the directive out over this hub\'s installations', async () => {
    const { writeParentBinding } = await import('../services/federation/parentBinding');
    const { federationTick } = await import('../services/federation/federationSync');
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
    await install(db, 'i1');

    const out: any = await federationTick({
      db, secretKey: SECRET, orgId: ORG, transport: transport(directive()),
    } as any);

    expect(out.upgradeFanout?.upgraded).toBe(1);
    expect((await db.get<any>('SELECT COUNT(*) AS n FROM upgrade_directive_targets'))).toMatchObject({ n: 1 });
  });

  it('does not let a broken upgrade directive stop the outbox drain', async () => {
    const { writeParentBinding } = await import('../services/federation/parentBinding');
    const { federationTick } = await import('../services/federation/federationSync');
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
    await db.run(
      `INSERT INTO federation_outbox (id, kind, payload, created_at, next_attempt_at)
       VALUES (?, 'event', ?, ?, ?)`,
      ['ob-1', JSON.stringify({ event: { eventId: 'e1', type: 'item.closed' } }),
       new Date(0).toISOString(), new Date(0).toISOString()],
    );
    await install(db, 'i1');
    const realRun = db.run.bind(db);
    db.run = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO upgrade_directives/i.test(sql)) throw new Error('database is locked');
      return realRun(sql, params);
    };
    let out: any;
    try {
      out = await federationTick({
        db, secretKey: SECRET, orgId: ORG, transport: transport(directive()),
      } as any);
    } finally {
      db.run = realRun;
    }
    expect(out.upgradeDispatchError).toMatch(/database is locked/);
    expect(out.delivered).toBe(1);
  });

  it('surfaces an unusable directive as an error instead of retrying it in silence', async () => {
    // The parent re-serves until the child reports, so a directive the child
    // refuses is re-attempted every tick. Returning the refusal as a plain
    // value left nothing in the result and nothing in the log — a permanent,
    // invisible loop.
    const { writeParentBinding } = await import('../services/federation/parentBinding');
    const { federationTick } = await import('../services/federation/federationSync');
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });
    await install(db, 'i1');

    const out: any = await federationTick({
      db, secretKey: SECRET, orgId: ORG, transport: transport(directive({ targetVersion: 'latest' })),
    } as any);

    expect(out.upgradeDispatchError).toBeTruthy();
  });
});

describe('the shared eligibility rules', () => {
  it('includes an installation with no git email at all', async () => {
    // The hidden-people exclusion is expressed as NOT IN over an org-scoped
    // subquery, and `NULL NOT IN (...)` is NULL rather than true — so without
    // a COALESCE a machine with no recorded email drops out of every
    // fleet-wide upgrade silently.
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, git_email, agenfk_version)
       VALUES (?, ?, ?, ?, NULL, '1.0.0')`,
      ['anon', ORG, now, now],
    );
    await db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', [ORG, 'someone@acme.com']);

    const out = await applyUpgradeDispatch(db, ORG, directive());
    expect(out.upgraded).toBe(1);
    expect(out.skipped).toEqual([]);
  });
});
