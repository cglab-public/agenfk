import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * CI read tokens and the read-only receipts API (RFC-002, task 0e0a3cd4).
 *
 * CI decides whether to skip a step on the strength of a receipt another
 * machine published. It reads with a `ci_` token an org admin mints, and the
 * promises pinned here are the ones that keep that token a READER:
 *
 *  - **A CI token is not an api key.** It lives in its own table, so no route
 *    that takes an installation's key accepts it: it cannot write events,
 *    publish receipts, claim a repository's command or read flow selection.
 *    And an installation's key is not a CI token either.
 *
 *  - **Scoped to one repository by default, or explicitly to the whole org.**
 *    A repository token asking about another repository is refused (403); a
 *    token never sees another org's receipts, which answer exactly like a
 *    receipt that does not exist (404), so the API is no oracle for them.
 *
 *  - **Lookup by repository + PR number**, through the pr.opened event that
 *    links the PR to its root card, **falling back to the content tree** when
 *    the PR names no card with receipts. The API only finds candidates; it
 *    returns each one's tree, revision and reusability for the CI side to
 *    judge, and the report can be downloaded inflated.
 *
 *  - **Issuance and revocation are audited**, and the audit row never holds
 *    the token.
 *
 * SQLite and pg-mem both: the PR lookup reads a JSON payload field, which is
 * exactly the SQL a dialect translator gets wrong.
 */

const SECRET = 'a'.repeat(64);
const ADMIN_EMAIL = 'admin@x';
const MEMBER_EMAIL = 'member@x';
const PASSWORD = 'longenough1';

const REPO_HTTPS = 'https://github.com/acme/app.git';
const CANON = 'git@github.com:acme/app.git';
const REPO2_HTTPS = 'https://github.com/acme/widget.git';
const CANON2 = 'git@github.com:acme/widget.git';
const CMD = 'npm test';

const TREE = 'a'.repeat(40);
const TREE_OTHER = 'c'.repeat(40);
const COMMIT = 'b'.repeat(40);
const LOG = 'PASS suite one\nPASS suite two\n';

let __server: any;

type Backend = 'sqlite' | 'postgres';

const hubConfig = (db: HubDb) => ({
  dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
} as any);

describe.each<Backend>(['sqlite', 'postgres'])('hub CI read tokens and receipts API (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieMember: string;
  let keyA: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const srv = () => supertest(__server);

  /** Mint a CI token as the org-a admin; the reply's body. */
  const mint = async (body: Record<string, unknown>) => {
    const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { token: string; tokenHashPreview: string; repo: string | null; scope: string; label: string | null };
  };

  const report = (text = LOG) => ({
    report: { encoding: 'gzip+base64', data: zlib.gzipSync(Buffer.from(text)).toString('base64'), bytes: Buffer.byteLength(text) },
  });

  const verification = (over: Record<string, any> = {}): any => ({
    id: randomUUID(),
    kind: 'verification',
    version: 1,
    repo: REPO_HTTPS,
    receiptsMode: 'shadow',
    card: { id: 'card-root', title: 'Root', type: 'STORY', closedAt: '2026-06-01T10:00:00.000Z', owner: null, closedBy: { name: 'Dev', email: 'dev@acme.test' }, link: null },
    execution: { id: 'test-1', command: CMD, commandRevision: 1, exitCode: 0, startedAt: '2026-06-01T09:59:00.000Z', finishedAt: '2026-06-01T10:00:00.000Z', logPath: null },
    content: { commit: COMMIT, gitTree: TREE, treeState: null, treeStateVersion: 1 },
    reusable: true,
    ...over,
  });

  const review = (lenses: string[], over: Record<string, any> = {}): any => ({
    id: randomUUID(),
    kind: 'review',
    version: 1,
    repo: REPO_HTTPS,
    receiptsMode: 'shadow',
    card: { id: 'card-root', title: 'Root', type: 'STORY', owner: null, recordedBy: { name: 'Dev', email: 'dev@acme.test' }, link: null },
    review: {
      recordId: 'rec-1', recordedAt: '2026-06-01T10:00:00.000Z',
      reviewer: { client: 'codex', sessionId: 's-1', agentId: null },
      authors: [], independence: { outcome: 'pass', detail: 'independent' },
      range: { from: 'f'.repeat(40), to: COMMIT }, lenses,
      findings: [], fixesAfterReview: null, transcriptSha256: 'd'.repeat(64),
    },
    humanGates: [],
    content: { commit: COMMIT, gitTree: TREE },
    reusable: true,
    notReusableReason: null,
    ...over,
  });

  /** Publish a receipt as the allowed producer (inst-alice). */
  const publish = async (rcpt: any, withReport = true) => {
    const r = await srv().post('/v1/receipts').set(bearer(keyA)).send(withReport ? { receipt: rcpt, ...report() } : { receipt: rcpt });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return rcpt.id as string;
  };

  /**
   * A pr.opened event in the shape ingestion stores it: the envelope as
   * `payload`, the agent's own payload nested under `payload.payload`, the
   * root card in item_id and the canonical remote in remote_url.
   */
  const prOpened = async (org: string, remote: string, prNumber: number, cardId: string, at = '2026-06-01T11:00:00.000Z', type = 'pr.opened') => {
    const envelope = { type, itemId: cardId, payload: { prNumber, repo: 'acme/app' } };
    await db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, item_id, remote_url, payload)
       VALUES (?, ?, 'inst-alice', 'dev@acme.test', ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), org, at, at, type, cardId, remote, JSON.stringify(envelope)],
    );
  };

  const lookup = (token: string, q: Record<string, string | number>) =>
    srv().get('/v1/ci/receipts').query(q).set(bearer(token));

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp(hubConfig(db));
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    // pg-mem is one database per process: start every test from empty tables.
    for (const t of ['receipts', 'repo_producers', 'repo_command_revisions', 'repo_settings', 'events', 'ci_tokens', 'config_audit']) {
      try { await db.run(`DELETE FROM ${t}`, []); } catch { /* the table may not exist yet: the implementation is what adds ci_tokens */ }
    }
    await createPasswordUser(db, 'org-a', ADMIN_EMAIL, PASSWORD, 'admin').catch(() => undefined);
    await createPasswordUser(db, 'org-a', MEMBER_EMAIL, PASSWORD, 'viewer').catch(() => undefined);
    cookieAdmin = await loginAs(__server, ADMIN_EMAIL, PASSWORD);
    cookieMember = await loginAs(__server, MEMBER_EMAIL, PASSWORD);
    keyA = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
    for (const [id, org] of [['inst-alice', 'org-a'], ['inst-other', 'org-b']] as const) {
      await db.run('DELETE FROM installations WHERE id = ?', [id]);
      await db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', 'dev@acme.test')`,
        [id, org],
      );
    }

    // Two repositories this org verifies, inst-alice the producer of both.
    for (const repo of [REPO_HTTPS, REPO2_HTTPS]) {
      const init = await srv().post('/v1/repo-settings/init').set(bearer(keyA)).send({ repo, verifyCommand: CMD });
      expect([200, 201], JSON.stringify(init.body)).toContain(init.status);
      const p = await srv().put('/v1/admin/repos/producers').set('Cookie', cookieAdmin)
        .send({ repo, installationId: 'inst-alice', allowed: true });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
    // org-b claims the same repository: its receipts must never reach org-a's CI.
    const initB = await srv().post('/v1/repo-settings/init').set(bearer(keyB)).send({ repo: REPO_HTTPS, verifyCommand: 'make test' });
    expect([200, 201], JSON.stringify(initB.body)).toContain(initB.status);
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  // ── minting ──────────────────────────────────────────────────────────────
  describe('POST /v1/admin/ci-tokens', () => {
    it('mints a ci_ token scoped to one repository by default, in the canonical spelling', async () => {
      const t = await mint({ label: 'github-actions', repo: REPO_HTTPS });
      expect(t.token).toMatch(/^ci_[0-9a-f]{64}$/);
      expect(t).toMatchObject({ scope: 'repo', repo: CANON, label: 'github-actions' });
      expect(t.tokenHashPreview).toMatch(/^[0-9a-f]{8}$/);
    });

    it('needs a repository unless the whole organisation is asked for explicitly', async () => {
      const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ label: 'ci' });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('repo_required');
    });

    it('mints an org-wide token only when scope is org, and then takes no repository', async () => {
      const t = await mint({ label: 'org-ci', scope: 'org' });
      expect(t).toMatchObject({ scope: 'org', repo: null });
      const both = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ scope: 'org', repo: REPO_HTTPS });
      expect(both.status, JSON.stringify(both.body)).toBe(400);
      expect(both.body.code).toBe('invalid_scope');
    });

    it('refuses a scope it does not know', async () => {
      const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ scope: 'everything', repo: REPO_HTTPS });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_scope');
    });

    it('refuses a repository this organisation does not verify', async () => {
      const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ repo: 'https://github.com/acme/unknown.git' });
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.code).toBe('repo_unknown');
    });

    it('refuses a repository that is not a usable remote', async () => {
      const r = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieAdmin).send({ repo: 42 });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_repo');
    });

    it('is for admins only: a member and an installation key are refused', async () => {
      const member = await srv().post('/v1/admin/ci-tokens').set('Cookie', cookieMember).send({ repo: REPO_HTTPS });
      expect(member.status).toBe(403);
      const key = await srv().post('/v1/admin/ci-tokens').set(bearer(keyA)).send({ repo: REPO_HTTPS });
      expect(key.status).toBe(401);
    });

    it('stores only the token hash, never the token', async () => {
      const t = await mint({ repo: REPO_HTTPS });
      const rows = await db.all<any>('SELECT * FROM ci_tokens', []);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(t.token);
      expect(rows[0].org_id).toBe('org-a');
      expect(rows[0].remote_url).toBe(CANON);
    });

    it('is audited without the token, and so is the revocation', async () => {
      const t = await mint({ label: 'gha', repo: REPO_HTTPS });
      const del = await srv().delete(`/v1/admin/ci-tokens/${t.tokenHashPreview}`).set('Cookie', cookieAdmin);
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      const audit = await db.all<any>("SELECT action, area, before_json, after_json, actor_email FROM config_audit WHERE org_id = 'org-a' ORDER BY at", []);
      const actions = audit.map(a => a.action);
      expect(actions).toContain('ci-token.issue');
      expect(actions).toContain('ci-token.revoke');
      for (const a of audit) expect(JSON.stringify(a)).not.toContain(t.token);
      expect(audit.find(a => a.action === 'ci-token.issue')?.actor_email).toBe(ADMIN_EMAIL);
    });
  });

  // ── listing and revoking ─────────────────────────────────────────────────
  describe('GET and DELETE /v1/admin/ci-tokens', () => {
    it('lists this org\'s tokens with scope and repo, never the token or its full hash', async () => {
      const t = await mint({ label: 'gha', repo: REPO_HTTPS });
      await mint({ label: 'org-ci', scope: 'org' });
      const r = await srv().get('/v1/admin/ci-tokens').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.tokens).toHaveLength(2);
      const gha = r.body.tokens.find((x: any) => x.label === 'gha');
      expect(gha).toMatchObject({ tokenHashPreview: t.tokenHashPreview, scope: 'repo', repo: CANON, revokedAt: null, createdByEmail: ADMIN_EMAIL });
      const raw = JSON.stringify(r.body);
      expect(raw).not.toContain(t.token);
      const row = await db.get<any>('SELECT token_hash FROM ci_tokens WHERE label = ?', ['gha']);
      expect(raw).not.toContain(row.token_hash);
    });

    it('does not list another org\'s tokens', async () => {
      await mint({ repo: REPO_HTTPS });
      await db.run(
        "INSERT INTO ci_tokens (token_hash, org_id, remote_url, label, created_at) VALUES (?, 'org-b', NULL, 'theirs', '2026-01-01T00:00:00Z')",
        ['e'.repeat(64)],
      );
      const r = await srv().get('/v1/admin/ci-tokens').set('Cookie', cookieAdmin);
      expect(r.body.tokens.map((x: any) => x.label)).not.toContain('theirs');
    });

    it('revokes a token so it reads nothing afterwards', async () => {
      const t = await mint({ repo: REPO_HTTPS });
      expect((await lookup(t.token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE })).status).toBe(200);
      const del = await srv().delete(`/v1/admin/ci-tokens/${t.tokenHashPreview}`).set('Cookie', cookieAdmin);
      expect(del.body).toEqual({ revoked: 1 });
      expect((await lookup(t.token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE })).status).toBe(401);
      const listed = await srv().get('/v1/admin/ci-tokens').set('Cookie', cookieAdmin);
      expect(listed.body.tokens[0].revokedAt).toBeTruthy();
    });

    it('refuses a preview that is a pattern rather than a hex prefix', async () => {
      await mint({ repo: REPO_HTTPS });
      const r = await srv().delete('/v1/admin/ci-tokens/%25').set('Cookie', cookieAdmin);
      expect(r.status).toBe(400);
      expect((await db.all<any>('SELECT revoked_at FROM ci_tokens', []))[0].revoked_at).toBeNull();
    });

    it('cannot revoke another org\'s token', async () => {
      const hash = 'e'.repeat(64);
      await db.run(
        "INSERT INTO ci_tokens (token_hash, org_id, remote_url, label, created_at) VALUES (?, 'org-b', NULL, 'theirs', '2026-01-01T00:00:00Z')",
        [hash],
      );
      const r = await srv().delete(`/v1/admin/ci-tokens/${hash.slice(0, 8)}`).set('Cookie', cookieAdmin);
      expect(r.body).toEqual({ revoked: 0 });
      expect((await db.get<any>('SELECT revoked_at FROM ci_tokens WHERE token_hash = ?', [hash])).revoked_at).toBeNull();
    });
  });

  // ── a reader, never a writer ─────────────────────────────────────────────
  describe('a CI token is read-only', () => {
    it('cannot write events, publish receipts, claim a command or read flow selection', async () => {
      const { token } = await mint({ scope: 'org' });
      const events = await srv().post('/v1/events').set(bearer(token)).send({ events: [] });
      expect(events.status).toBe(401);
      const receipts = await srv().post('/v1/receipts').set(bearer(token)).send({ receipt: verification() });
      expect(receipts.status).toBe(401);
      const init = await srv().post('/v1/repo-settings/init').set(bearer(token)).send({ repo: 'https://github.com/acme/new.git', verifyCommand: CMD });
      expect(init.status).toBe(401);
      const flows = await srv().get('/v1/flows/active').set(bearer(token));
      expect(flows.status).toBe(401);
      expect(await db.all('SELECT * FROM receipts', [])).toHaveLength(0);
    });

    it('is not an admin session either', async () => {
      const { token } = await mint({ scope: 'org' });
      const r = await srv().post('/v1/admin/ci-tokens').set(bearer(token)).send({ scope: 'org' });
      expect(r.status).toBe(401);
    });

    it('an installation key is not a CI token', async () => {
      const r = await lookup(keyA, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(r.status).toBe(401);
    });

    it('refuses a missing, unknown or malformed token', async () => {
      expect((await srv().get('/v1/ci/receipts').query({ repo: REPO_HTTPS, kind: 'verification', tree: TREE })).status).toBe(401);
      expect((await lookup('ci_' + '0'.repeat(64), { repo: REPO_HTTPS, kind: 'verification', tree: TREE })).status).toBe(401);
      expect((await lookup('', { repo: REPO_HTTPS, kind: 'verification', tree: TREE })).status).toBe(401);
    });
  });

  // ── lookup ───────────────────────────────────────────────────────────────
  describe('GET /v1/ci/receipts', () => {
    it('finds the root card\'s receipts through the PR\'s pr.opened event', async () => {
      const id = await publish(verification());
      await prOpened('org-a', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.repo).toBe(CANON);
      expect(r.body.settings).toMatchObject({ verifyCommand: CMD, revision: 1, receiptsMode: 'off' });
      expect(r.body.lookup).toMatchObject({ by: 'pr', pr: 42, cardId: 'card-root' });
      expect(r.body.receipts).toHaveLength(1);
      expect(r.body.receipts[0]).toMatchObject({
        id, kind: 'verification', cardId: 'card-root', contentTree: TREE, commit: COMMIT,
        commandRevision: 1, reusable: true, notReusableReason: null, installationId: 'inst-alice',
        report: { available: true, bytes: Buffer.byteLength(LOG) },
      });
      expect(r.body.receipts[0].receivedAt).toBeTruthy();
      // A summary: the receipt body and the report bytes are fetched separately.
      expect(r.body.receipts[0].receipt).toBeUndefined();
    });

    it('follows the latest PR event when the PR was re-registered on another card', async () => {
      await publish(verification());
      const other = await publish(verification({ card: { ...verification().card, id: 'card-new' } }));
      await prOpened('org-a', CANON, 42, 'card-root', '2026-06-01T11:00:00.000Z');
      await prOpened('org-a', CANON, 42, 'card-new', '2026-06-02T11:00:00.000Z', 'pr.updated');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42 });
      expect(r.body.lookup.cardId).toBe('card-new');
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([other]);
    });

    it('does not follow a PR event of another repository or another org', async () => {
      await publish(verification());
      await prOpened('org-a', CANON2, 42, 'card-root');
      await prOpened('org-b', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42 });
      expect(r.status).toBe(200);
      expect(r.body.lookup).toMatchObject({ by: null, cardId: null });
      expect(r.body.receipts).toEqual([]);
    });

    it('falls back to the content tree when the PR names no card', async () => {
      const id = await publish(verification());
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 7, tree: TREE });
      expect(r.body.lookup).toMatchObject({ by: 'tree', tree: TREE });
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([id]);
    });

    it('falls back to the content tree when the PR\'s card has no receipt of that kind', async () => {
      const id = await publish(verification({ card: { ...verification().card, id: 'card-elsewhere' } }));
      await prOpened('org-a', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42, tree: TREE });
      expect(r.body.lookup.by).toBe('tree');
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([id]);
    });

    // GH-291: a PR made of two root cards. The PR is registered on one, whose
    // receipt is for an older tree; the other closed last, on the PR's content.
    it('falls back to the content tree when none of the PR\'s card receipts is for the tree CI asks about', async () => {
      await publish(verification({ content: { commit: COMMIT, gitTree: TREE_OTHER, treeState: null, treeStateVersion: 1 } }));
      const sibling = await publish(verification({ card: { ...verification().card, id: 'card-sibling' } }));
      await prOpened('org-a', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42, tree: TREE });
      expect(r.body.lookup).toMatchObject({ by: 'tree', pr: 42, cardId: 'card-root', tree: TREE });
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([sibling]);
    });

    it('still answers by the PR when one of its card\'s receipts is for that tree, even with a sibling\'s for it too', async () => {
      const own = await publish(verification());
      await publish(verification({ card: { ...verification().card, id: 'card-sibling' } }));
      await prOpened('org-a', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42, tree: TREE });
      expect(r.body.lookup.by).toBe('pr');
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([own]);
    });

    it('keeps the PR card\'s stale receipts when nothing at all is for the tree, so CI can say why', async () => {
      const stale = await publish(verification({ content: { commit: COMMIT, gitTree: TREE_OTHER, treeState: null, treeStateVersion: 1 } }));
      await prOpened('org-a', CANON, 42, 'card-root');
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42, tree: TREE });
      expect(r.body.lookup.by).toBe('pr');
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([stale]);
    });

    it('looks up by tree alone, and only that tree', async () => {
      const id = await publish(verification());
      await publish(verification({ content: { commit: COMMIT, gitTree: TREE_OTHER, treeState: null, treeStateVersion: 1 } }));
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([id]);
    });

    it('returns only the kind asked for, and for a review only the lens asked for', async () => {
      await publish(verification());
      const general = await publish(review(['general']));
      const security = await publish(review(['general', 'security']));
      const { token } = await mint({ repo: REPO_HTTPS });
      const all = await lookup(token, { repo: REPO_HTTPS, kind: 'review', tree: TREE });
      expect(all.body.receipts.map((x: any) => x.id).sort()).toEqual([general, security].sort());
      expect(all.body.receipts.find((x: any) => x.id === security).lenses).toEqual(['general', 'security']);
      const sec = await lookup(token, { repo: REPO_HTTPS, kind: 'review', tree: TREE, lens: 'security' });
      expect(sec.body.receipts.map((x: any) => x.id)).toEqual([security]);
    });

    it('lists the newest receipt first', async () => {
      const first = await publish(verification());
      await new Promise(r => setTimeout(r, 5));
      const second = await publish(verification());
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([second, first]);
    });

    it('returns a receipt the hub refused to make reusable, with the reason', async () => {
      const id = await publish(verification({ reusable: false }));
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(r.body.receipts[0]).toMatchObject({ id, reusable: false, notReusableReason: 'not_reusable_by_producer' });
    });

    it('says whether the producer is on the allowlist NOW, not only when it published', async () => {
      const id = await publish(verification());
      const { token } = await mint({ repo: REPO_HTTPS });
      const before = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(before.body.receipts[0]).toMatchObject({ id, reusable: true, producerAllowed: true });
      const removed = await srv().put('/v1/admin/repos/producers').set('Cookie', cookieAdmin)
        .send({ repo: REPO_HTTPS, installationId: 'inst-alice', allowed: false });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      const after = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(after.body.receipts[0]).toMatchObject({ id, producerAllowed: false });
      const one = await srv().get(`/v1/ci/receipts/${id}`).set(bearer(token));
      expect(one.body.producerAllowed).toBe(false);
    });

    it('says when the evidence itself was made, which is not when the hub received it', async () => {
      // A receipt that waited offline arrives late: its run finished long before.
      await publish(verification({ execution: { ...verification().execution, finishedAt: '2020-01-02T03:04:05.000Z' } }));
      await publish(review(['general'], { review: { ...review(['general']).review, recordedAt: '2020-02-03T04:05:06.000Z' } }));
      const { token } = await mint({ repo: REPO_HTTPS });
      const v = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(v.body.receipts[0].evidenceAt).toBe('2020-01-02T03:04:05.000Z');
      expect(v.body.receipts[0].receivedAt > '2026').toBe(true);
      const rv = await lookup(token, { repo: REPO_HTTPS, kind: 'review', tree: TREE });
      expect(rv.body.receipts[0].evidenceAt).toBe('2020-02-03T04:05:06.000Z');
    });

    it('says a receipt published without a report has none', async () => {
      await publish(verification(), false);
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(r.body.receipts[0].report).toEqual({ available: false, bytes: null });
    });

    it('takes another spelling of the same repository', async () => {
      await publish(verification());
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: 'git@github.com:ACME/App', kind: 'verification', tree: TREE });
      expect(r.status).toBe(200);
      expect(r.body.receipts).toHaveLength(1);
    });

    it('validates the query', async () => {
      const { token } = await mint({ repo: REPO_HTTPS });
      const bad = async (q: Record<string, string | number>, code: string) => {
        const r = await lookup(token, q);
        expect(r.status, JSON.stringify({ q, body: r.body })).toBe(400);
        expect(r.body.code).toBe(code);
      };
      await bad({ kind: 'verification', tree: TREE }, 'invalid_repo');
      await bad({ repo: REPO_HTTPS, tree: TREE }, 'invalid_kind');
      await bad({ repo: REPO_HTTPS, kind: 'build', tree: TREE }, 'invalid_kind');
      await bad({ repo: REPO_HTTPS, kind: 'verification' }, 'lookup_required');
      await bad({ repo: REPO_HTTPS, kind: 'verification', pr: 'abc' }, 'invalid_pr');
      await bad({ repo: REPO_HTTPS, kind: 'verification', pr: 0 }, 'invalid_pr');
      await bad({ repo: REPO_HTTPS, kind: 'verification', tree: 'not-a-tree' }, 'invalid_tree');
      await bad({ repo: REPO_HTTPS, kind: 'verification', tree: TREE, lens: 'no spaces allowed' }, 'invalid_lens');
    });
  });

  // ── scope and tenancy ────────────────────────────────────────────────────
  describe('scope and tenancy', () => {
    it('a repository token cannot read another repository of the same org', async () => {
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await lookup(token, { repo: REPO2_HTTPS, kind: 'verification', tree: TREE });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe('repo_out_of_scope');
    });

    it('an org token reads every repository of its org', async () => {
      await publish(verification({ repo: REPO2_HTTPS }));
      const { token } = await mint({ scope: 'org' });
      const r = await lookup(token, { repo: REPO2_HTTPS, kind: 'verification', tree: TREE });
      expect(r.status).toBe(200);
      expect(r.body.repo).toBe(CANON2);
      expect(r.body.receipts).toHaveLength(1);
    });

    it('never returns another org\'s receipts for the same repository and tree', async () => {
      // org-b verifies the same repository and publishes a receipt on the same tree.
      await db.run(
        `INSERT INTO repo_producers (org_id, remote_url, installation_id, added_at) VALUES ('org-b', ?, 'inst-other', '2026-01-01T00:00:00Z')`,
        [CANON],
      );
      const theirs = verification();
      const pub = await srv().post('/v1/receipts').set(bearer(keyB)).send({ receipt: theirs, ...report('SECRET ORG B LOG') });
      expect(pub.status, JSON.stringify(pub.body)).toBe(201);
      await prOpened('org-b', CANON, 42, 'card-root');
      const { token } = await mint({ scope: 'org' });
      const byTree = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', tree: TREE });
      expect(byTree.body.receipts).toEqual([]);
      const byPr = await lookup(token, { repo: REPO_HTTPS, kind: 'verification', pr: 42 });
      expect(byPr.body.receipts).toEqual([]);
      // And org-b's settings are not the ones reported.
      expect(byTree.body.settings.verifyCommand).toBe(CMD);
      // Nor fetched by id.
      expect((await srv().get(`/v1/ci/receipts/${theirs.id}`).set(bearer(token))).status).toBe(404);
      expect((await srv().get(`/v1/ci/receipts/${theirs.id}/report`).set(bearer(token))).status).toBe(404);
    });

    it('a repository the org does not verify is unknown, whatever another org has', async () => {
      const { token } = await mint({ scope: 'org' });
      const r = await lookup(token, { repo: 'https://github.com/someone/else.git', kind: 'verification', tree: TREE });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('repo_unknown');
    });
  });

  // ── the admin's view of a repository's receipts ──────────────────────────
  describe('GET /v1/admin/repos/receipts and lastReceiptAt (the Repositories page)', () => {
    it('lists a repository\'s recent receipts, newest first, with the card title and the hub\'s verdict', async () => {
      const first = await publish(verification());
      await new Promise(r => setTimeout(r, 5));
      const second = await publish(review(['general', 'security'], { reusable: false, notReusableReason: 'not_independent' }));
      const r = await srv().get('/v1/admin/repos/receipts').query({ repo: REPO_HTTPS }).set('Cookie', cookieAdmin);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.receipts.map((x: any) => x.id)).toEqual([second, first]);
      expect(r.body.receipts[1]).toMatchObject({
        id: first, kind: 'verification', cardId: 'card-root', cardTitle: 'Root', reusable: true, notReusableReason: null,
        installationId: 'inst-alice', contentTree: TREE, commandRevision: 1,
      });
      expect(r.body.receipts[0]).toMatchObject({ id: second, kind: 'review', reusable: false, notReusableReason: 'not_reusable_by_producer', lenses: ['general', 'security'] });
      expect(r.body.receipts[0].receipt).toBeUndefined();
    });

    it('shows only this repository of this org', async () => {
      await publish(verification({ repo: REPO2_HTTPS }));
      await db.run(
        `INSERT INTO repo_producers (org_id, remote_url, installation_id, added_at) VALUES ('org-b', ?, 'inst-other', '2026-01-01T00:00:00Z')`,
        [CANON],
      );
      const theirs = await srv().post('/v1/receipts').set(bearer(keyB)).send({ receipt: verification() });
      expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
      const r = await srv().get('/v1/admin/repos/receipts').query({ repo: REPO_HTTPS }).set('Cookie', cookieAdmin);
      expect(r.body.receipts).toEqual([]);
    });

    it('is for admins only', async () => {
      expect((await srv().get('/v1/admin/repos/receipts').query({ repo: REPO_HTTPS }).set('Cookie', cookieMember)).status).toBe(403);
      const { token } = await mint({ scope: 'org' });
      expect((await srv().get('/v1/admin/repos/receipts').query({ repo: REPO_HTTPS }).set(bearer(token))).status).toBe(401);
    });

    it('refuses a repository that is not a usable remote', async () => {
      const r = await srv().get('/v1/admin/repos/receipts').query({ repo: '' }).set('Cookie', cookieAdmin);
      expect(r.status).toBe(400);
    });

    it('the repository list says when each repository last received a receipt', async () => {
      const id = await publish(verification());
      const row = await db.get<any>('SELECT received_at FROM receipts WHERE id = ?', [id]);
      const r = await srv().get('/v1/admin/repos').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      const byRepo = Object.fromEntries(r.body.repos.map((x: any) => [x.remoteUrl, x]));
      expect(byRepo[CANON].lastReceiptAt).toBe(String(row.received_at));
      expect(byRepo[CANON2].lastReceiptAt).toBeNull();
    });
  });

  // ── one receipt, and its report ──────────────────────────────────────────
  describe('GET /v1/ci/receipts/:id and its report', () => {
    it('returns the receipt exactly as published, with the hub\'s verdict', async () => {
      const rcpt = verification();
      await publish(rcpt);
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await srv().get(`/v1/ci/receipts/${rcpt.id}`).set(bearer(token));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ id: rcpt.id, reusable: true, installationId: 'inst-alice', contentTree: TREE });
      expect(r.body.receipt).toEqual(rcpt);
    });

    it('downloads the report inflated, as text', async () => {
      const rcpt = verification();
      await publish(rcpt);
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await srv().get(`/v1/ci/receipts/${rcpt.id}/report`).set(bearer(token));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/^text\/plain/);
      expect(r.text).toBe(LOG);
    });

    it('says a receipt without a report has none to download', async () => {
      const rcpt = verification();
      await publish(rcpt, false);
      const { token } = await mint({ repo: REPO_HTTPS });
      const r = await srv().get(`/v1/ci/receipts/${rcpt.id}/report`).set(bearer(token));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('report_unavailable');
    });

    it('a repository token cannot fetch a receipt of another repository, and learns nothing about it', async () => {
      const rcpt = verification({ repo: REPO2_HTTPS });
      await publish(rcpt);
      const { token } = await mint({ repo: REPO_HTTPS });
      const one = await srv().get(`/v1/ci/receipts/${rcpt.id}`).set(bearer(token));
      const unknown = await srv().get(`/v1/ci/receipts/${randomUUID()}`).set(bearer(token));
      expect(one.status).toBe(404);
      expect(one.body).toEqual(unknown.body);
      expect((await srv().get(`/v1/ci/receipts/${rcpt.id}/report`).set(bearer(token))).status).toBe(404);
    });
  });
});
