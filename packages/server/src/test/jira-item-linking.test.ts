/**
 * Linking a card to a JIRA item outside of the importer.
 *
 * `externalId` / `externalUrl` have been on AgEnFKItem since the JIRA importer
 * landed, and the UI already renders them as a clickable badge — but the only
 * writers were the JIRA import (server.ts) and the GitHub import. `POST /items`
 * and `PUT /items/:id` destructure a fixed field list that omits both, so no
 * other route could attach a reference. These tests pin the write paths that
 * close that gap:
 *
 *   - `jiraItem` on create and update resolves a key into the reference pair;
 *   - `jiraItem: 'none'` unlinks;
 *   - omitting `jiraItem` leaves an existing reference alone (a PUT that edits
 *     the title must not silently drop the JIRA link);
 *   - linking is REFERENCE ONLY — the card keeps its own title and description,
 *     which is what separates a link from an import;
 *   - with an OAuth token present the key is confirmed against JIRA and the
 *     browse URL is derived from the token's cloudUrl; without one the key is
 *     format-checked and stored bare.
 *
 * The externalUrl scheme check is a security control, not tidiness: both
 * KanbanBoard.tsx and CardDetailModal.tsx render `href={item.externalUrl}`
 * with no sanitising, so a stored `javascript:` URL is a stored-XSS trigger on
 * click. The server is the only place that can refuse it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mockable homedir so the JIRA token this suite writes lands in a sandbox and
// never touches the real ~/.agenfk (see home-isolation.test.ts for why).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: vi.fn(() => actual.homedir()) }, homedir: vi.fn(() => actual.homedir()) };
});

// server.ts calls axios(...) as a function for every JIRA API request.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const fn: any = vi.fn(async () => ({ data: {} }));
  fn.get = vi.fn(async () => ({ data: {} }));
  fn.post = vi.fn(async () => ({ data: {} }));
  fn.create = actual.default?.create ?? vi.fn(() => fn);
  fn.isAxiosError = actual.default?.isAxiosError ?? (() => false);
  return { ...actual, default: fn };
});

import axios from 'axios';
import { app, initStorage, JIRA_HTTP_TIMEOUT_MS, isJiraBrowseUrlFor, describeRejectedInput } from '../server';

const TEST_DB = path.resolve('./jira-item-linking-test-db.sqlite');
const SANDBOX_HOME = path.join(os.tmpdir(), 'agenfk-jira-link-home');
const CLOUD_URL = 'https://cg-lab.atlassian.net';

const setHome = (dir: string | null) => {
  const homedir = os.homedir as unknown as ReturnType<typeof vi.fn>;
  homedir.mockImplementation(() => dir ?? SANDBOX_HOME);
};

const writeJiraToken = () => {
  const dir = path.join(SANDBOX_HOME, '.agenfk');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'jira-token.json'),
    JSON.stringify({
      access_token: 'tok',
      refresh_token: 'ref',
      cloudId: 'cloud-1',
      cloudUrl: CLOUD_URL,
    }),
  );
};

/** refreshJiraToken() returns early unless OAuth client credentials exist. */
const writeJiraClientConfig = () => {
  const dir = path.join(SANDBOX_HOME, '.agenfk');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ jira: { clientId: 'cid', clientSecret: 'secret' } }),
  );
};

const clearJiraToken = () => {
  const tokenFile = path.join(SANDBOX_HOME, '.agenfk', 'jira-token.json');
  if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
};

/** An axios rejection shaped the way the JIRA client sees a real HTTP error. */
const httpError = (status: number) => {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: {} };
  err.isAxiosError = true;
  return err;
};

describe('linking a card to a JIRA item', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.mkdirSync(SANDBOX_HOME, { recursive: true });
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // resetAllMocks, not clearAllMocks: clear wipes CALLS but keeps
    // implementations, so a mockRejectedValue set in one test survives into the
    // next. Harmless today only by luck of ordering — a landmine for the next
    // test added here. Reset, then re-establish the benign default.
    vi.resetAllMocks();
    (axios as any).mockResolvedValue({ data: {} });
    (axios as any).post.mockResolvedValue({ data: {} });
    setHome(SANDBOX_HOME);
    clearJiraToken();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'jira-link' });
    projectId = p.body.id;
  });

  const createItem = (body: Record<string, unknown> = {}) =>
    request(app).post('/items').send({ type: 'TASK', title: 'Fix the picker dismiss', projectId, ...body });

  // ── create ────────────────────────────────────────────────────────────────

  describe('POST /items with jiraItem (disconnected)', () => {
    it('stores the format-checked key with no URL when no JIRA token is present', async () => {
      const res = await createItem({ jiraItem: 'CGLAB-163' });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl ?? null).toBeNull();
    });

    it('persists the reference, so a later read still carries it', async () => {
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
    });

    it('normalises a lowercase key before storing it', async () => {
      const res = await createItem({ jiraItem: 'cglab-163' });
      expect(res.body.externalId).toBe('CGLAB-163');
    });

    it('rejects a malformed key with 400 and creates nothing', async () => {
      const res = await createItem({ jiraItem: 'not a key' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/not a key|JIRA/i);
      const list = await request(app).get('/items').query({ projectId });
      expect(list.body).toHaveLength(0);
    });

    it('leaves the reference empty when jiraItem is omitted', async () => {
      const res = await createItem();
      expect(res.status).toBe(201);
      expect(res.body.externalId ?? null).toBeNull();
    });

    it('keeps the caller title — linking is a reference, not an import', async () => {
      const res = await createItem({ jiraItem: 'CGLAB-163', description: 'mine' });
      // The link must actually have happened, or this asserts nothing at all.
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.title).toBe('Fix the picker dismiss');
      expect(res.body.description).toBe('mine');
    });
  });

  // ── update ────────────────────────────────────────────────────────────────

  describe('PUT /items/:id with jiraItem', () => {
    it('links an existing card that was created without a reference', async () => {
      const created = await createItem();
      expect(created.body.externalId ?? null).toBeNull();

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });
      expect(res.status).toBe(200);
      expect(res.body.externalId).toBe('CGLAB-163');
    });

    it('does not touch the card title or description when linking', async () => {
      const created = await createItem({ description: 'mine' });
      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.title).toBe('Fix the picker dismiss');
      expect(res.body.description).toBe('mine');
    });

    it('re-links to a different key, replacing the previous reference', async () => {
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-999' });
      expect(res.body.externalId).toBe('CGLAB-999');
    });

    it("unlinks on the 'none' sentinel, clearing both the id and the URL", async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      expect(created.body.externalUrl).toBe(`${CLOUD_URL}/browse/CGLAB-163`);

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'none' });
      expect(res.status).toBe(200);
      expect(res.body.externalId ?? null).toBeNull();
      expect(res.body.externalUrl ?? null).toBeNull();
    });

    it('accepts the unlink sentinel in any casing, clearing both fields', async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      expect(created.body.externalUrl).toBe(`${CLOUD_URL}/browse/CGLAB-163`);

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: '  NoNe  ' });
      expect(res.body.externalId ?? null).toBeNull();
      expect(res.body.externalUrl ?? null).toBeNull();
    });

    it('leaves an existing reference alone when the update omits jiraItem', async () => {
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      const res = await request(app).put(`/items/${created.body.id}`).send({ title: 'Renamed' });
      expect(res.body.title).toBe('Renamed');
      expect(res.body.externalId).toBe('CGLAB-163');
    });

    it('rejects a malformed key with 400 and leaves the stored reference untouched', async () => {
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'nope' });
      expect(res.status).toBe(400);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
    });
  });

  // ── validate-if-connected ─────────────────────────────────────────────────

  describe('with a JIRA OAuth token present', () => {
    beforeEach(() => writeJiraToken());

    it('confirms the key against JIRA and derives the browse URL from cloudUrl', async () => {
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163', fields: { summary: 'x' } } });

      const res = await createItem({ jiraItem: 'CGLAB-163' });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl).toBe(`${CLOUD_URL}/browse/CGLAB-163`);
      expect(axios).toHaveBeenCalled();
      const requestedUrl = (axios as any).mock.calls[0][0].url;
      expect(requestedUrl).toContain('CGLAB-163');
    });

    it('rejects a well-formed key that does not exist in JIRA', async () => {
      (axios as any).mockRejectedValue(httpError(404));

      const res = await createItem({ jiraItem: 'CGLAB-99999' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('CGLAB-99999');
      const list = await request(app).get('/items').query({ projectId });
      expect(list.body).toHaveLength(0);
    });

    it('rejects a key the token is not authorised to read, creating nothing', async () => {
      (axios as any).mockRejectedValue(httpError(403));
      const res = await createItem({ jiraItem: 'SECRET-1' });
      expect(res.status).toBe(400);
      const list = await request(app).get('/items').query({ projectId });
      expect(list.body).toHaveLength(0);
    });

    it('still links when JIRA is unreachable, and says so rather than failing silently', async () => {
      (axios as any).mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

      const res = await createItem({ jiraItem: 'CGLAB-163' });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(String(res.body.jiraWarning ?? '')).toMatch(/verif/i);
    });

    it('does not call JIRA at all when unlinking', async () => {
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      (axios as any).mockClear();

      await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'none' });
      expect(axios).not.toHaveBeenCalled();
    });
  });

  // ── the archive/unarchive early returns (found in adversarial review) ─────
  //
  // PUT /items/:id returns early for both archive transitions. The reference
  // resolution originally sat BELOW those returns, so an archiving update
  // answered 200 having written no link — and, worse, answered 200 for a
  // MALFORMED key instead of 400. Every path that can answer success must
  // validate.

  describe('archive and unarchive transitions', () => {
    it('applies the link on the same request that archives the card', async () => {
      const created = await createItem();
      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'ARCHIVED', jiraItem: 'CGLAB-163' });

      expect(res.status).toBe(200);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
      expect(read.body.status).toBe('ARCHIVED');
    });

    it('rejects a malformed key on an archiving update instead of answering 200', async () => {
      const created = await createItem();
      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'ARCHIVED', jiraItem: 'not a key' });

      expect(res.status).toBe(400);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.status).not.toBe('ARCHIVED');
    });

    it('refuses an unsafe externalUrl on an archiving update', async () => {
      const created = await createItem();
      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'ARCHIVED', externalUrl: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid type on an archiving update, instead of archiving anyway', async () => {
      // Behaviour CHANGE, pinned deliberately. The type and parent guards used
      // to sit BELOW the archive early return, so an archiving request skipped
      // them entirely. Moving the reference resolution above the return moved
      // those guards with it. Recording the new answer so the change is visible
      // rather than incidental.
      const created = await createItem();

      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'ARCHIVED', type: 'BOGUS' });

      expect(res.status).toBe(400);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.status).not.toBe('ARCHIVED');
    });

    it('applies the link on the request that unarchives the card', async () => {
      const created = await createItem();
      await request(app).put(`/items/${created.body.id}`).send({ status: 'ARCHIVED' });

      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'TODO', jiraItem: 'CGLAB-163' });

      expect(res.status).toBe(200);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
      expect(read.body.status).toBe('TODO');
    });
  });

  // ── bounded network calls ─────────────────────────────────────────────────

  describe('outbound JIRA calls are bounded', () => {
    it('passes an explicit timeout on the validation request, so a stalled JIRA cannot hang the write', async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });

      await createItem({ jiraItem: 'CGLAB-163' });

      const config = (axios as any).mock.calls[0][0];
      expect(config.timeout).toBe(JIRA_HTTP_TIMEOUT_MS);
      expect(config.timeout).toBeGreaterThan(0);
    });

    it('bounds the TOKEN REFRESH too, which is the call that could hang unbounded', async () => {
      // A 401 sends jiraApiRequest through refreshJiraToken, whose POST to
      // auth.atlassian.com carried no timeout of its own — so bounding only the
      // validation request left the actual stall path open.
      writeJiraToken();
      writeJiraClientConfig();
      const unauthorized = httpError(401);
      (axios as any).mockRejectedValue(unauthorized);
      (axios as any).post.mockResolvedValue({
        data: { access_token: 'new', refresh_token: 'newref', expires_in: 3600 },
      });

      await createItem({ jiraItem: 'CGLAB-163' });

      expect((axios as any).post).toHaveBeenCalled();
      const [url, , config] = (axios as any).post.mock.calls[0];
      expect(String(url)).toContain('auth.atlassian.com');
      expect(config?.timeout).toBe(JIRA_HTTP_TIMEOUT_MS);
    });
  });

  // ── a disconnected re-link must not destroy a verified URL ────────────────

  describe('re-linking while disconnected', () => {
    it('keeps a previously verified URL when the same key is re-linked offline', async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem({ jiraItem: 'CGLAB-163' });
      expect(created.body.externalUrl).toBe(`${CLOUD_URL}/browse/CGLAB-163`);

      clearJiraToken();
      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });

      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl).toBe(`${CLOUD_URL}/browse/CGLAB-163`);
    });

    it('drops the stale URL when a DIFFERENT key is linked offline', async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem({ jiraItem: 'CGLAB-163' });

      clearJiraToken();
      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-999' });

      expect(res.body.externalId).toBe('CGLAB-999');
      // The old URL pointed at CGLAB-163; keeping it would mislabel the badge.
      expect(res.body.externalUrl ?? null).toBeNull();
    });

    it('refuses to store a derived URL that is not a URL at all', async () => {
      // A JIRA OAuth resource with no `url` yields the literal string
      // "undefined/browse/KEY". It must not reach the item, because the UI
      // renders externalUrl straight into an href.
      const dir = path.join(SANDBOX_HOME, '.agenfk');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'jira-token.json'),
        JSON.stringify({ access_token: 't', refresh_token: 'r', cloudId: 'c' }),
      );
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });

      const res = await createItem({ jiraItem: 'CGLAB-163' });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl ?? null).toBeNull();
    });
  });

  // ── 'none' on create ──────────────────────────────────────────────────────

  describe("the unlink sentinel on create", () => {
    it('creates an unlinked card without calling JIRA', async () => {
      writeJiraToken();
      const res = await createItem({ jiraItem: 'none' });
      expect(res.status).toBe(201);
      expect(res.body.externalId ?? null).toBeNull();
      expect(axios).not.toHaveBeenCalled();
    });
  });

  // ── gaps found in the second adversarial review ──────────────────────────
  //
  // Each of these covers a fix that was in the code but pinned by NOTHING, so
  // reverting the fix left the suite green.

  describe('bounds on the jiraItem path', () => {
    it('refuses an absurdly long key, which was the way around both length caps', async () => {
      // The grammar is anchored but not finite, so a 5000-character project key
      // matched it and landed in the item's JSON blob — and, when connected, in
      // the derived browse URL, past the 2048 URL cap.
      const res = await createItem({ jiraItem: `${'A'.repeat(5000)}-1` });
      expect(res.status).toBe(400);
      const list = await request(app).get('/items').query({ projectId });
      expect(list.body).toHaveLength(0);
    });

    it('accepts a key of a realistic length', async () => {
      const res = await createItem({ jiraItem: 'ABCDEFGHIJ-123456' });
      expect(res.status).toBe(201);
    });
  });

  describe('the archive path reports an unverified link', () => {
    it('returns the warning when archiving and linking in one request', async () => {
      writeJiraToken();
      (axios as any).mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const created = await createItem();

      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ status: 'ARCHIVED', jiraItem: 'CGLAB-163' });

      expect(res.status).toBe(200);
      // Without this the link is written unverified and the CLI prints nothing.
      expect(String(res.body.jiraWarning ?? '')).toMatch(/verif/i);
    });
  });

  describe('the update path reports an unverified link', () => {
    it('returns the warning on an ordinary link of an existing card', async () => {
      writeJiraToken();
      (axios as any).mockRejectedValue(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      const created = await createItem();

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });

      expect(res.status).toBe(200);
      expect(String(res.body.jiraWarning ?? '')).toMatch(/verif/i);
    });
  });

  describe('an offline re-link compares keys case-insensitively', () => {
    it('keeps the URL when the stored id differs only in case', async () => {
      // A raw externalId is stored verbatim, while a parsed key is uppercased,
      // so a case-sensitive compare dropped a perfectly good URL.
      const created = await createItem({
        externalId: 'cglab-163',
        externalUrl: 'https://cg-lab.atlassian.net/browse/cglab-163',
      });

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });

      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl).toBe('https://cg-lab.atlassian.net/browse/cglab-163');
    });

    it('does not keep a URL that is not a browse link for this key', async () => {
      const created = await createItem({
        externalId: 'CGLAB-163',
        externalUrl: 'https://example.com/somewhere-else',
      });

      const res = await request(app).put(`/items/${created.body.id}`).send({ jiraItem: 'CGLAB-163' });

      expect(res.body.externalId).toBe('CGLAB-163');
      expect(res.body.externalUrl ?? null).toBeNull();
    });
  });

  describe('local guards run before the JIRA round-trip', () => {
    it('rejects a bad type without spending a live JIRA call', async () => {
      writeJiraToken();
      (axios as any).mockResolvedValue({ data: { key: 'CGLAB-163' } });
      const created = await createItem();

      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ type: 'BOGUS', jiraItem: 'CGLAB-163' });

      expect(res.status).toBe(400);
      expect(axios).not.toHaveBeenCalled();
    });
  });

  describe('POST /items/bulk carries a reference like the single-item routes', () => {
    it('links through the bulk route instead of dropping the field', async () => {
      const created = await createItem();

      const res = await request(app)
        .post('/items/bulk')
        .send({ items: [{ id: created.body.id, updates: { jiraItem: 'CGLAB-163' } }] });

      expect(res.status).toBe(200);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
    });

    it('links on the same bulk entry that archives the card', async () => {
      // The bulk loop `continue`s on the archive branches, so a reference
      // resolved after them was dropped on exactly those entries — the same
      // bug PUT had, inherited by the route that copied its shape.
      const created = await createItem();

      const res = await request(app)
        .post('/items/bulk')
        .send({ items: [{ id: created.body.id, updates: { status: 'ARCHIVED', jiraItem: 'CGLAB-163' } }] });

      expect(res.status).toBe(200);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
      expect(read.body.status).toBe('ARCHIVED');
    });

    it('reports a malformed key on an archiving bulk entry instead of accepting it silently', async () => {
      const created = await createItem();

      const res = await request(app)
        .post('/items/bulk')
        .send({ items: [{ id: created.body.id, updates: { status: 'ARCHIVED', jiraItem: 'not a key' } }] });

      expect(res.body.skipped).toEqual([
        expect.objectContaining({ id: created.body.id, error: expect.stringContaining('JIRA') }),
      ]);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId ?? null).toBeNull();
    });

    it('reports an unverified bulk link in warnings, which is not the same as skipped', async () => {
      // An entry in `skipped` means "this did not happen"; an unverified link
      // DID happen. Reporting it as a skip would be a false failure.
      writeJiraToken();
      (axios as any).mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const created = await createItem();

      const res = await request(app)
        .post('/items/bulk')
        .send({ items: [{ id: created.body.id, updates: { jiraItem: 'CGLAB-163' } }] });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body.warnings ?? [])).toMatch(/verif/i);
      expect(JSON.stringify(res.body.skipped ?? [])).not.toMatch(/verif/i);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId).toBe('CGLAB-163');
    });

    it('does NOT claim an unverified link on an entry it then abandoned', async () => {
      // The warning used to be emitted before the write, so an entry rejected
      // later by the parent guard still reported a link that never happened.
      writeJiraToken();
      (axios as any).mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const created = await createItem();

      const res = await request(app).post('/items/bulk').send({
        items: [{ id: created.body.id, updates: { parentId: 'does-not-exist', jiraItem: 'CGLAB-163' } }],
      });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body.warnings ?? [])).not.toMatch(/verif/i);
      expect(JSON.stringify(res.body.skipped ?? [])).toMatch(/not found/i);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalId ?? null).toBeNull();
    });

    it('reports a bad key in skipped rather than answering 200 with nothing done', async () => {
      const created = await createItem();

      const res = await request(app)
        .post('/items/bulk')
        .send({ items: [{ id: created.body.id, updates: { jiraItem: 'not a key' } }] });

      expect(res.body.skipped).toEqual([
        expect.objectContaining({ id: created.body.id, error: expect.stringContaining('JIRA') }),
      ]);
    });
  });

  // ── the browse-URL shape rule, pinned rather than merely commented ───────

  describe('isJiraBrowseUrlFor', () => {
    it('matches a plain browse URL for the key', () => {
      expect(isJiraBrowseUrlFor('https://x.atlassian.net/browse/CGLAB-163', 'CGLAB-163')).toBe(true);
    });

    it('tolerates a context path, as JIRA Server/DC uses', () => {
      expect(isJiraBrowseUrlFor('https://jira.acme.com/jira/browse/CGLAB-163', 'CGLAB-163')).toBe(true);
    });

    it("accepts a percent-encoded key, since '%2D' spells '-'", () => {
      expect(isJiraBrowseUrlFor('https://x/browse/CGLAB%2D163', 'CGLAB-163')).toBe(true);
    });

    it('does not let %2F smuggle a path separator', () => {
      // Decoding the whole path and then comparing would read this single real
      // segment as '/x/browse/CGLAB-163'. Segments are decoded individually.
      expect(isJiraBrowseUrlFor('https://x/x%2Fbrowse%2FCGLAB-163', 'CGLAB-163')).toBe(false);
    });

    it('returns false rather than throwing on a malformed percent escape', () => {
      expect(isJiraBrowseUrlFor('https://x/browse/%E0%A4%A', 'CGLAB-163')).toBe(false);
    });

    it('tolerates a trailing slash rather than dropping a usable URL', () => {
      expect(isJiraBrowseUrlFor('https://x/browse/CGLAB-163/', 'CGLAB-163')).toBe(true);
    });

    it('rejects a browse URL for a different key', () => {
      expect(isJiraBrowseUrlFor('https://x/browse/OTHER-1', 'CGLAB-163')).toBe(false);
    });

    it('rejects an unsafe scheme even with the right path', () => {
      expect(isJiraBrowseUrlFor('javascript:/browse/CGLAB-163', 'CGLAB-163')).toBe(false);
    });
  });

  describe('describeRejectedInput', () => {
    it('never throws, whatever it is handed', () => {
      const circular: any = {}; circular.self = circular;
      for (const value of [undefined, null, 42, Symbol('s'), 10n, () => {}, circular, { toString: null, valueOf: null }]) {
        expect(() => describeRejectedInput(value)).not.toThrow();
      }
    });

    it('strips control characters, which would otherwise reach the operator terminal', () => {
      const out = describeRejectedInput('a\u0000b\u001bc\u007fd');
      expect(out).toBe('abcd');
    });

    it('truncates without splitting an astral character in half', () => {
      // The fixture matters. '😀'.repeat(200) cuts at code unit 80, which is an
      // EVEN boundary, so even the broken slice() left the pairs intact and this
      // test passed against unfixed code. 79 ASCII chars push the cut onto an
      // odd offset, landing inside a surrogate pair.
      const out = describeRejectedInput(`${'a'.repeat(79)}${'😀'.repeat(5)}`);
      // A high surrogate not followed by a low one. Asserting a specific code
      // unit was also wrong: 😀 is \uD83D\uDE00, so '\uD800' never appeared.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
      expect([...out].length).toBeLessThanOrEqual(81);
    });
  });

  // ── externalUrl is an href in the UI: the scheme is a security control ────

  describe('raw externalId / externalUrl', () => {
    it('accepts a caller-supplied http(s) reference, for non-JIRA trackers', async () => {
      const res = await createItem({
        externalId: '4321',
        externalUrl: 'https://github.com/cglab-public/agenfk/issues/4321',
      });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe('4321');
      expect(res.body.externalUrl).toBe('https://github.com/cglab-public/agenfk/issues/4321');
    });

    it('refuses a javascript: externalUrl, which the UI would render as a live href', async () => {
      const res = await createItem({ externalId: 'X-1', externalUrl: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
      const list = await request(app).get('/items').query({ projectId });
      expect(list.body).toHaveLength(0);
    });

    it('refuses a data: externalUrl on update as well as on create', async () => {
      const created = await createItem();
      const res = await request(app)
        .put(`/items/${created.body.id}`)
        .send({ externalUrl: 'data:text/html;base64,PHNjcmlwdD4=' });
      expect(res.status).toBe(400);
      const read = await request(app).get(`/items/${created.body.id}`);
      expect(read.body.externalUrl ?? null).toBeNull();
    });

    it('refuses a URL carrying embedded credentials, which reads as a phishing href', async () => {
      const res = await createItem({ externalId: 'X-1', externalUrl: 'http://user:pass@evil.example.com/x' });
      expect(res.status).toBe(400);
    });

    it('rejects an object with no primitive conversion as 400, not 500', async () => {
      // String(raw) throws TypeError on { toString: null, valueOf: null },
      // which escaped as a 500 from the very path meant to reject cleanly.
      const res = await createItem({ jiraItem: { toString: null, valueOf: null } });
      expect(res.status).toBe(400);
    });

    it('truncates the echo of a rejected value instead of returning it whole', async () => {
      const res = await createItem({ jiraItem: 'Z'.repeat(5000) });
      expect(res.status).toBe(400);
      expect(String(res.body.error).length).toBeLessThan(300);
    });

    it('refuses a non-string externalId instead of storing "[object Object]"', async () => {
      const res = await createItem({ externalId: { a: 1 } });
      expect(res.status).toBe(400);
    });

    it('refuses an over-long externalId rather than bloating the stored item', async () => {
      const res = await createItem({ externalId: 'X'.repeat(5000) });
      expect(res.status).toBe(400);
    });

    it('refuses an over-long externalUrl', async () => {
      const res = await createItem({ externalUrl: `https://example.com/${'x'.repeat(4000)}` });
      expect(res.status).toBe(400);
    });

    it('lets jiraItem win over a conflicting raw externalId, so the validated value is the one stored', async () => {
      const res = await createItem({ jiraItem: 'CGLAB-163', externalId: 'SPOOF-1' });
      expect(res.body.externalId).toBe('CGLAB-163');
    });
  });
});
