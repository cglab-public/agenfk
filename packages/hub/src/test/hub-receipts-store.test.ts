import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import * as zlib from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * The receipts store (RFC-002, task 0334a5e6).
 *
 * A receipt is a claim another machine has to honour: "this command, run on
 * this tree, passed on this card". The hub is where such a claim becomes a
 * record, so the promises this file pins down are the ones that make the claim
 * worth anything:
 *
 *  - **Write-once.** A receipt is never overwritten and never duplicated. The
 *    receipt's own id, minted by the client that built it, is the primary key:
 *    the same body twice is one row and a retry (200 `duplicate`), the same id
 *    with a different body is a conflict (409) and the original row does not
 *    move. The conflict is answered without saying anything about another
 *    org's row — an id being taken is not an oracle for whose id it is.
 *
 *  - **The producer is the credential, never the body.** `installation_id`
 *    comes from the api key that posted. A key bound to no installation cannot
 *    be a producer at all, because a shareable CI key is not one machine.
 *
 *  - **The hub decides reusability at write time**, from its own allowlist and
 *    its own report cap, and records why it said no. A client cannot make its
 *    own receipt reusable, and a client that says `reusable: false` is heard.
 *
 *  - **A repository the org has never heard of gets no receipt** (404), so the
 *    store cannot be filled with claims about repos nobody verifies.
 *
 *  - **Receipts are activity, not configuration** — no audit row, and the
 *    completeness test's exemption list says so.
 *
 * The repo is keyed on the canonical URL, so a receipt naming
 * `https://github.com/acme/app.git` lands on the record an installation claimed
 * with `git@github.com:acme/app.git`.
 *
 * Run against SQLite and pg-mem: the write-once insert is `INSERT OR IGNORE`
 * on one dialect and `ON CONFLICT DO NOTHING` on the other, which is exactly
 * the statement a dialect translator gets wrong.
 */

const SECRET = 'a'.repeat(64);
const ADMIN_EMAIL = 'admin@x';
const PASSWORD = 'longenough1';

const REPO_HTTPS = 'https://github.com/acme/app.git';
const CANON = 'git@github.com:acme/app.git';
const REPO_OTHER = 'https://github.com/acme/widget.git';
const CMD_A = 'npm test';

/** A tree hash, as git prints one — 40 hex. */
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);

let __server: any;

type Backend = 'sqlite' | 'postgres';

/**
 * The `createHubApp` config the outer suite boots with. `receiptReportMaxBytes`
 * is left to its default here; the one test that needs a tiny cap boots its own
 * app with its own config (see the nested describe at the end).
 */
const hubConfig = (db: HubDb) => ({
  dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
} as any);

describe.each<Backend>(['sqlite', 'postgres'])('hub receipts store (%s)', (backend) => {
  // `db` and `__server` are always read live (never captured in a helper's
  // closure): the small-cap hub at the end of the file replaces both in the
  // same `beforeEach` chain, and a request to a closed server answers 404, a
  // closed database throws — which is a far cry from the failure being pinned.
  let db: HubDb;
  const live = () => db;
  const liveServer = () => __server;
  let cookieAdmin: string;
  let keyA: string;
  let keyA2: string;
  let keyB: string;
  let keyShared: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

  /** POST /v1/receipts as `key` — the route under test, spelled out once. */
  const post = (key: string | null, body: Record<string, unknown>) => {
    const r = supertest(liveServer()).post('/v1/receipts').send(body as any);
    return key === null ? r : r.set(bearer(key));
  };

  /** A gzip report body in the shape the route takes: base64 of a gzip stream. */
  const reportOf = (text = 'log line\n'.repeat(10)) => {
    const plain = Buffer.from(text);
    return {
      report: {
        encoding: 'gzip+base64' as const,
        data: zlib.gzipSync(plain).toString('base64'),
        bytes: plain.length,
      },
    };
  };

  /**
   * A verification receipt in the shape the client writes it (task f918a42c):
   * the fields the route reads, each with a plausible value. Override any of
   * them, or add a field, with `over`.
   */
  const receipt = (over: Record<string, any> = {}): any => ({
    id: randomUUID(),
    kind: 'verification',
    version: 1,
    repo: REPO_HTTPS,
    receiptsMode: 'shadow',
    card: {
      id: 'card-1',
      title: 'Store the receipt',
      type: 'TASK',
      closedAt: '2026-06-01T10:00:00.000Z',
      owner: null,
      closedBy: { name: 'Dev', email: 'dev@acme.test' },
      link: null,
    },
    execution: {
      id: 'test-1',
      command: CMD_A,
      commandRevision: 1,
      exitCode: 0,
      startedAt: '2026-06-01T09:59:00.000Z',
      finishedAt: '2026-06-01T10:00:00.000Z',
      logPath: '/home/dev/.agenfk/logs/test-1.log',
    },
    content: {
      commit: COMMIT,
      gitTree: TREE,
      treeState: null,
      treeStateVersion: 1,
    },
    reusable: true,
    ...over,
  });

  /** One body for the route: the receipt and, unless told otherwise, a report. */
  const body = (rcpt: Record<string, any>, report: Record<string, unknown> | null = reportOf()) =>
    report === null ? { receipt: rcpt } : { receipt: rcpt, ...report };

  const rows = async (): Promise<any[]> => live().all<any>('SELECT * FROM receipts', []);
  const rowFor = (id: string) => live().get<any>('SELECT * FROM receipts WHERE id = ?', [id]);
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  // The repo under test: the org claimed the command with `producerKey`, and
  // the admin allowed `producerInstallation` to produce receipts for it.
  //
  // The pg-mem database is one per process, so a hub booted later in the same
  // run can find the record an earlier test wrote: `init` is first-writer-wins
  // and answers 200 with the standing settings, which is the same starting
  // state. `inst-bob` is deliberately left off the allowlist — it is the
  // "not a producer" case, so the allowlist is always exactly one installation.
  const seedRepo = async (srv: any, producerKey: string, adminCookie: string, producerInstallation: string, on: HubDb) => {
    const init = await supertest(srv).post('/v1/repo-settings/init').set(bearer(producerKey))
      .send({ repo: REPO_HTTPS, verifyCommand: CMD_A });
    expect([200, 201], JSON.stringify(init.body)).toContain(init.status);
    // Start from an empty allowlist. The pg-mem database is one per process, so
    // a row another test allowed can be standing here — and 'is this
    // installation a producer?' is exactly what the allowlist cases below
    // answer. Membership rows are the hub's own state, not the feature under
    // test, so the reset is the DELETE the admin's PUT would have made.
    await on.run('DELETE FROM repo_producers WHERE org_id = ?', ['org-a']);
    const producers = await supertest(srv).put('/v1/admin/repos/producers').set('Cookie', adminCookie)
      .send({ repo: REPO_HTTPS, installationId: producerInstallation, allowed: true });
    expect(producers.status, JSON.stringify(producers.body)).toBe(200);
    expect(producers.body.producers, JSON.stringify(producers.body)).toEqual([producerInstallation]);
  };

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp(hubConfig(db));
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    await createPasswordUser(db, 'org-a', ADMIN_EMAIL, PASSWORD, 'admin');
    cookieAdmin = await loginAs(__server, ADMIN_EMAIL, PASSWORD);
    // Installation-bound keys, as `hub login` and invites issue them.
    keyA = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyA2 = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
    // An admin-minted key bound to no installation: shareable, e.g. a CI key.
    keyShared = await issueApiKey(db, 'org-a', 'ci');
    for (const [id, org] of [['inst-alice', 'org-a'], ['inst-bob', 'org-a'], ['inst-other', 'org-b']] as const) {
      await db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', 'dev@acme.test')`,
        [id, org],
      );
    }
  // The repository under test: this org claimed the command and inst-alice is
  // the only producer. `beforeEach` runs for the small-cap hub below too, and
  // the pg-mem database is one per process, so `init` may answer 200 with the
  // record an earlier hub wrote — the same starting state, arrived at twice.
    await seedRepo(liveServer(), keyA, cookieAdmin, 'inst-alice', live());
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
    vi.unstubAllGlobals();
  });

  // ── a first receipt ──────────────────────────────────────────────────────
  // Codex review of RFC-002.
  describe('POST /v1/receipts — what a receipt must be', () => {
    it('refuses an id with characters CI output cannot carry safely (a newline could forge a step output)', async () => {
      for (const id of ['r\nrun=false', 'r\rx', 'a b', 'r;x', 'r"x']) {
        const r = await post(keyA, body(receipt({ id })));
        expect(r.status, JSON.stringify({ id, body: r.body })).toBe(400);
        expect(r.body.code).toBe('invalid_receipt');
      }
      expect(await rows()).toHaveLength(0);
    });

    it('takes the ids clients mint: uuids and short dotted names', async () => {
      for (const id of [randomUUID(), 'rcpt-1', 'vr_01JB4K.a:b']) {
        const r = await post(keyA, body(receipt({ id })));
        expect(r.status, JSON.stringify({ id, body: r.body })).toBe(201);
      }
    });

    const reviewReceipt = (review: Record<string, unknown> | undefined) => {
      const { execution: _e, ...rest } = receipt({ kind: 'review' });
      return review === undefined ? rest : { ...rest, review };
    };
    const goodReview = { recordId: 'rec-1', lenses: ['general'], findings: [{ title: 't', state: 'fixed' }], independence: { outcome: 'pass' } };

    it('refuses a review receipt with no findings list, or no lenses: a review CI could reuse must say what it found and covered', async () => {
      for (const review of [undefined, { ...goodReview, findings: undefined }, { ...goodReview, findings: 'none' }, { ...goodReview, lenses: [] }, { ...goodReview, lenses: undefined }]) {
        const r = await post(keyA, body(reviewReceipt(review as any), null));
        expect(r.status, JSON.stringify({ review, body: r.body })).toBe(400);
        expect(r.body.code).toBe('invalid_receipt');
      }
    });

    it('takes a review receipt whose findings list is empty: a clean review found nothing', async () => {
      const r = await post(keyA, body(reviewReceipt({ ...goodReview, findings: [] }), null));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });
  });

  describe('POST /v1/receipts — a first receipt', () => {
    it('stores it as new and reusable, with the key\'s installation and the canonical repo', async () => {
      const rcpt = receipt();
      const r = await post(keyA, body(rcpt));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ id: rcpt.id, stored: 'new', reusable: true, reason: null });

      const row = await rowFor(rcpt.id);
      expect(row, 'the row is readable by the receipt id').toBeTruthy();
      expect(row.org_id).toBe('org-a');
      // The body's claim about who published is ignored: the key is the producer.
      expect(row.installation_id).toBe('inst-alice');
      expect(row.remote_url).toBe(CANON);
      expect(row.kind).toBe('verification');
      expect(row.card_id).toBe('card-1');
      expect(row.content_tree).toBe(TREE);
      expect(Number(row.command_revision)).toBe(1);
      expect(Number(row.reusable)).toBe(1);
      expect(row.not_reusable_reason).toBeNull();
      // The receipt exactly as received, and a hash of exactly that.
      expect(JSON.parse(row.body_json)).toEqual(rcpt);
      expect(row.body_hash).toBe(sha256(row.body_json));
      expect(row.received_at).toBeTruthy();
      // The report, kept, and its size as the client declared it.
      const report = reportOf();
      expect(Buffer.from(row.report_gz_b64, 'base64').equals(Buffer.from(report.report.data, 'base64'))).toBe(true);
      expect(Number(row.report_bytes)).toBe(report.report.bytes);
    });

    it('ignores an installation the body claims for itself', async () => {
      const rcpt = receipt({ installationId: 'inst-other' });
      const r = await post(keyA, body(rcpt));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const row = await rowFor(rcpt.id);
      expect(row.installation_id).toBe('inst-alice');
      expect(row.org_id).toBe('org-a');
    });

    it('takes the report from another spelling of the same repo', async () => {
      // The hub claimed the repo with the https URL; a receipt naming the ssh
      // spelling is the same repository, so it lands on the same canonical row.
      const r = await post(keyA, body(receipt({ repo: 'git@github.com:ACME/App' })));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await rows())[0].remote_url).toBe(CANON);
    });

    it('stores a receipt with no report at all', async () => {
      const rcpt = receipt();
      const r = await post(keyA, body(rcpt, null));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ stored: 'new', reusable: true, reason: null });
      const row = await rowFor(rcpt.id);
      expect(row.report_gz_b64).toBeNull();
      expect(row.report_bytes).toBeNull();
    });
  });

  // ── write-once ───────────────────────────────────────────────────────────
  describe('write-once, idempotent by id', () => {
    it('the same body again is a duplicate, and still one row', async () => {
      const rcpt = receipt();
      const first = await post(keyA, body(rcpt));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const again = await post(keyA, body(rcpt));
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toMatchObject({ id: rcpt.id, stored: 'duplicate', reusable: true, reason: null });
      expect(await rows()).toHaveLength(1);
    });

    it('the same id with a different body is a conflict, and the original row does not move', async () => {
      const rcpt = receipt();
      const first = await post(keyA, body(rcpt));
      expect(first.status).toBe(201);
      const before = await rowFor(rcpt.id);
      expect(before.body_hash).toBeTruthy();

      const clash = await post(keyA, body(receipt({ ...rcpt, card: { ...rcpt.card, title: 'a different claim' } })));
      expect(clash.status, JSON.stringify(clash.body)).toBe(409);
      expect(clash.body.code).toBe('receipt_conflict');

      const after = await rowFor(rcpt.id);
      expect(after.body_hash).toBe(before.body_hash);
      expect(after.body_json).toBe(before.body_json);
      expect(await rows()).toHaveLength(1);
    });

    it('another org may not write over an id its own key already used, and org-a\'s row is untouched', async () => {
      const rcpt = receipt();
      expect((await post(keyA, body(rcpt))).status).toBe(201);
      const before = await rowFor(rcpt.id);

      // org-b's key, its own org, its own settings row, the id org-a already
      // used. `init` is first-writer-wins and the pg-mem database is shared per
      // process, so org-b's record may already stand from an earlier test.
      const initOther = await supertest(liveServer()).post('/v1/repo-settings/init').set(bearer(keyB))
        .send({ repo: REPO_HTTPS, verifyCommand: CMD_A });
      expect([200, 201], JSON.stringify(initOther.body)).toContain(initOther.status);
      // And org-b's installation must not sit on its own producer allowlist
      // either, so the only reason the id is refused is the id, not the
      // producer. org-b has no board session here, so the row comes off the
      // table directly — membership in the org's own allowlist, written by this
      // test rather than asserted by it.
      await live().run('DELETE FROM repo_producers WHERE org_id = ? AND installation_id = ?', ['org-b', 'inst-other']);
      const clash = await post(keyB, body(rcpt));
      expect(clash.status, JSON.stringify(clash.body)).toBe(409);
      expect(clash.body.code).toBe('receipt_conflict');
      // The refusal says nothing about the row that caused it.
      expect(JSON.stringify(clash.body)).not.toContain('org-a');
      expect(JSON.stringify(clash.body)).not.toContain('org-b');

      const after = await rowFor(rcpt.id);
      expect(after.org_id).toBe('org-a');
      expect(after.body_hash).toBe(before.body_hash);
      expect(after.installation_id).toBe('inst-alice');
      // And org-b wrote nothing of its own either.
      expect(await rows()).toHaveLength(1);
    });
  });

  // ── the hub decides reusability ──────────────────────────────────────────
  describe('reusable is decided here, at write time', () => {
    it('a producer off the allowlist is stored, but not reusable', async () => {
      const rcpt = receipt();
      const r = await post(keyA2, body(rcpt));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ id: rcpt.id, stored: 'new', reusable: false, reason: 'producer_not_allowed' });
      const row = await rowFor(rcpt.id);
      expect(row.installation_id).toBe('inst-bob');
      expect(Number(row.reusable)).toBe(0);
      expect(row.not_reusable_reason).toBe('producer_not_allowed');
    });

    it('a report the client gave up on is not reusable, and nothing is stored for it', async () => {
      const rcpt = receipt();
      const r = await post(keyA, body(rcpt, { report: { omitted: 'over_cap', bytes: 99_999_999 } }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ stored: 'new', reusable: false, reason: 'report_over_cap' });
      const row = await rowFor(rcpt.id);
      expect(Number(row.reusable)).toBe(0);
      expect(row.not_reusable_reason).toBe('report_over_cap');
      expect(row.report_gz_b64).toBeNull();
      // The size the client declared is still recorded, so the board can say how big.
      expect(Number(row.report_bytes)).toBe(99_999_999);
    });

    it('a receipt its producer does not offer as reusable is not reusable', async () => {
      const rcpt = receipt({ reusable: false });
      const r = await post(keyA, body(rcpt));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ stored: 'new', reusable: false, reason: 'not_reusable_by_producer' });
      const row = await rowFor(rcpt.id);
      expect(Number(row.reusable)).toBe(0);
      expect(row.not_reusable_reason).toBe('not_reusable_by_producer');
    });
  });

  // ── what is refused ──────────────────────────────────────────────────────
  describe('refusals', () => {
    it('refuses a key bound to no installation', async () => {
      const r = await post(keyShared, body(receipt()));
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe('installation_key_required');
      expect(r.body.error).toBeTruthy();
      expect(await rows()).toHaveLength(0);
    });

    it('refuses a repository the org has never heard of', async () => {
      const r = await post(keyA, body(receipt({ repo: REPO_OTHER })));
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.code).toBe('repo_unknown');
      expect(await rows()).toHaveLength(0);
    });

    it('refuses a receipt that is not a receipt, and writes nothing', async () => {
      const bad: Array<[string, Record<string, any>]> = [
        ['a kind nobody issues', receipt({ kind: 'vibe-check' })],
        ['no kind at all', (() => { const r = receipt(); delete r.kind; return r; })()],
        ['no id', (() => { const r = receipt(); delete r.id; return r; })()],
        ['an empty id', receipt({ id: '' })],
        ['an id that is not a string', receipt({ id: 42 })],
        ['an id longer than an id', receipt({ id: 'x'.repeat(65) })],
        ['version 2', receipt({ version: 2 })],
        ['no version', (() => { const r = receipt(); delete r.version; return r; })()],
        ['no repo', (() => { const r = receipt(); delete r.repo; return r; })()],
        ['a repo that is not a git remote', receipt({ repo: 'not a repo' })],
        ['no receipt at all', { nope: true }],
      ];
      for (const [what, rcpt] of bad) {
        const r = await post(keyA, body(rcpt));
        expect(r.status, `${what} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code, what).toBe('invalid_receipt');
        expect(r.body.error, what).toBeTruthy();
      }
      expect(await rows()).toHaveLength(0);
    });

    it('refuses a report that is not a gzip stream, and writes nothing', async () => {
      const notGzip = [
        Buffer.from('plain text, no gzip at all').toString('base64'),
        'this is not even base64 ~~~',
        '',
      ];
      for (const data of notGzip) {
        const r = await post(keyA, { receipt: receipt(), report: { encoding: 'gzip+base64', data, bytes: 100 } });
        expect(r.status, `${data.slice(0, 12)} -> ${JSON.stringify(r.body)}`).toBe(400);
        expect(r.body.code).toBe('invalid_report');
      }
      expect(await rows()).toHaveLength(0);
    });

    it('needs a key at all', async () => {
      const r = await post(null, body(receipt()));
      expect(r.status).toBe(401);
      expect(await rows()).toHaveLength(0);
    });
  });

  // ── the report cap ───────────────────────────────────────────────────────
  // A hub whose cap is tiny, so "the report is too big" is testable without
  // shipping megabytes: the same route, the same decision, a smaller number.
  // Its `beforeEach` runs after the outer one and replaces both the database
  // and the listening server; the outer `afterEach` tears this pair down the
  // same way, because every reader goes through `live()` / `liveServer()`.
  describe('with receiptReportMaxBytes: 64', () => {
    let capKey: string;

    beforeEach(async () => {
      const capDb = await openSqliteDb(':memory:');
      const out = await createHubApp({ ...hubConfig(capDb), receiptReportMaxBytes: 64 });
      await new Promise<void>(r => __server.close(() => r()));
      __server = out.app.listen(0);
      await createPasswordUser(capDb, 'org-a', ADMIN_EMAIL, PASSWORD, 'admin');
      const admin = await loginAs(__server, ADMIN_EMAIL, PASSWORD);
      capKey = await issueApiKey(capDb, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
      await capDb.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES ('inst-alice', 'org-a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', 'dev@acme.test')`,
      );
      await seedRepo(liveServer(), capKey, admin, 'inst-alice', capDb);
      db = capDb;
    });

    it('a report larger than the cap is not reusable and its bytes are not stored', async () => {
      // Incompressible, so the gzip really is bigger than 64 bytes.
      const big = Buffer.from(Array.from({ length: 4096 }, (_, i) => String.fromCharCode(48 + (i % 10))).join(''));
      const rcpt = receipt();
      const r = await post(capKey, {
        receipt: rcpt,
        report: { encoding: 'gzip+base64', data: zlib.gzipSync(big).toString('base64'), bytes: big.length },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ stored: 'new', reusable: false, reason: 'report_over_cap' });

      const row = await rowFor(rcpt.id);
      expect(Number(row.reusable)).toBe(0);
      expect(row.not_reusable_reason).toBe('report_over_cap');
      expect(row.report_gz_b64).toBeNull();
      expect(Number(row.report_bytes)).toBe(big.length);
    });

    it('a report under the cap still lands, and is reusable', async () => {
      const small = Buffer.from('log line\n');
      const r = await post(capKey, {
        receipt: receipt(),
        report: { encoding: 'gzip+base64', data: zlib.gzipSync(small).toString('base64'), bytes: small.length },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ reusable: true, reason: null });
    });
  });
});
