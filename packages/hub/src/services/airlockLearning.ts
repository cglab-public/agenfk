import {
  DEFAULT_AIRLOCK_POLICY,
  evidenceOf,
  learnableHost,
  learningExclusionOf,
  normalizeAirlockPolicy,
  withAcceptedHosts,
  AIRLOCK_PROPOSAL_LIMIT,
  MAX_LEARNED_CLIENTS,
  type AirlockLearningEvidence,
} from '@agenfk/core';
import type { DB } from '../db.js';
import { AirlockPolicyError, getAirlockPolicy, putAirlockPolicy, reportTimeOf, type AirlockPolicyView } from './airlock.js';

/**
 * Airlock learning proposals (GH-294, TEL-3). A hub-joined installation cannot
 * change the org's policy, so a person there forwards the hosts its sessions
 * reached as an `airlock.learning-proposal` event: host names and counts, no
 * commands, URLs or card ids. The hub keeps the latest report of each host
 * from each installation (airlock_learning_reports) and lists them to the
 * admin one row per host, however many installations proposed it.
 *
 * Nothing is applied until an admin accepts: that saves the next revision of
 * the org's policy through putAirlockPolicy (same validation, same
 * compare-and-swap), and the route is audited like the policy save. A host the
 * policy already allows, denies or lists as an IOC - or a metadata or private
 * address - is never listed and cannot be accepted (core learningExclusionOf),
 * and one the policy already covers when it arrives is not stored.
 *
 * Bounded: a report older than LEARNING_RETENTION_MS is dropped, and an org
 * keeps at most MAX_LEARNING_REPORTS_PER_ORG rows (oldest report first), both
 * pruned on insert. The list is aggregated in SQL with a LIMIT, and an accept
 * reads only the rows of the hosts it names.
 */

/** Hosts one event may carry; the installation sends at most the proposal's limit. */
export const MAX_PROPOSAL_HOSTS = AIRLOCK_PROPOSAL_LIMIT;
const MAX_HITS = 2147483647;
const MAX_CLIENT_CHARS = 64;
/** How long a report is kept. */
export const LEARNING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Report rows one org keeps; past it the oldest reports go first. */
export const MAX_LEARNING_REPORTS_PER_ORG = 20_000;
/** Grouped hosts read per page while collecting the eligible ones. */
export const LIST_PAGE = AIRLOCK_PROPOSAL_LIMIT;

const whole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= MAX_HITS;
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * One installation's forwarded proposal. Each entry that is a bare host with a
 * count is kept, replacing that installation's earlier report of the host
 * unless this one is older; anything else in an entry is never read. Returns
 * how many hosts were kept. Written after the events commit (routes/events.ts).
 */
export async function recordAirlockLearningProposal(
  db: DB, orgId: string, e: { installationId: string; occurredAt: string }, payload: unknown,
): Promise<number> {
  const list = (payload as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(list)) return 0;
  const at = reportTimeOf(e.occurredAt);
  if (!at) return 0;
  const policy = policyOf(await getAirlockPolicy(db, orgId));
  let kept = 0;
  for (const raw of list.slice(0, MAX_PROPOSAL_HOSTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const host = learnableHost(p.host);
    if (!host || !whole(p.hits, 1) || learningExclusionOf(host, policy)) continue;
    const proxy = (p.sources as Record<string, unknown> | undefined)?.proxy;
    const proxyHits = whole(proxy, 0) ? Math.min(proxy, p.hits) : 0;
    const clients = Array.isArray(p.clients)
      ? [...new Set(p.clients.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= MAX_CLIENT_CHARS && !c.includes('\u0000')))].slice(0, MAX_LEARNED_CLIENTS)
      : [];
    const result = await db.run(
      `INSERT INTO airlock_learning_reports (org_id, host, installation_id, hits, proxy_hits, clients_json, first_seen, last_seen, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, host, installation_id) DO UPDATE SET
         hits = excluded.hits, proxy_hits = excluded.proxy_hits, clients_json = excluded.clients_json,
         first_seen = excluded.first_seen, last_seen = excluded.last_seen, reported_at = excluded.reported_at
       WHERE airlock_learning_reports.reported_at <= excluded.reported_at`,
      [orgId, host, e.installationId, p.hits, proxyHits, JSON.stringify(clients), isoOrNull(p.firstSeen), isoOrNull(p.lastSeen), at],
    );
    if (result.changes > 0) kept++;
  }
  await pruneLearningReports(db, orgId);
  return kept;
}

/** Drop reports past the retention, then the oldest past the per-org cap. */
export async function pruneLearningReports(db: DB, orgId: string, now: number = Date.now(), cap: number = MAX_LEARNING_REPORTS_PER_ORG): Promise<void> {
  await db.run('DELETE FROM airlock_learning_reports WHERE org_id = ? AND reported_at < ?', [orgId, new Date(now - LEARNING_RETENTION_MS).toISOString()]);
  const edge = await db.get<{ reported_at: string | Date }>(
    `SELECT reported_at FROM airlock_learning_reports WHERE org_id = ? ORDER BY reported_at DESC LIMIT 1 OFFSET ${Math.max(0, Math.floor(cap))}`,
    [orgId],
  );
  // Ties at the edge are dropped too: the cap is a bound, never exceeded.
  if (edge) await db.run('DELETE FROM airlock_learning_reports WHERE org_id = ? AND reported_at <= ?', [orgId, iso(edge.reported_at)]);
}

export interface AirlockLearningHostView {
  host: string;
  /** Installations that proposed it. */
  installations: number;
  hits: number;
  proxyHits: number;
  evidence: AirlockLearningEvidence;
  clients: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}

const parseList = (text: unknown): string[] => {
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
};

const policyOf = (view: AirlockPolicyView) => view.policy ?? normalizeAirlockPolicy(DEFAULT_AIRLOCK_POLICY);

/**
 * THE ranking, in SQL only (the code keeps the order it is given): proxy
 * evidence first, then most installations, most hits, and host. Shared by
 * every page, so pages never overlap or skip.
 */
const GROUPS = `SELECT host, COUNT(*) AS installations, SUM(hits) AS total_hits, SUM(proxy_hits) AS total_proxy,
         CASE WHEN SUM(proxy_hits) > 0 THEN 0 ELSE 1 END AS tier,
         MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
    FROM airlock_learning_reports WHERE org_id = ?`;
const RANKING = 'GROUP BY host ORDER BY tier, installations DESC, total_hits DESC, host';

/**
 * The proposed hosts the org's policy does not already cover, one row per
 * host across installations, grouped and ranked in SQL. Pages of groups are
 * read until AIRLOCK_PROPOSAL_LIMIT eligible hosts are found or the groups
 * run out - bounded, since an org keeps at most MAX_LEARNING_REPORTS_PER_ORG
 * rows - so rows a newer deny or IOC entry covers can never hide eligible
 * hosts ranked below them. `only` limits it to those hosts (an accept).
 */
async function proposedHosts(db: DB, orgId: string, view: AirlockPolicyView, only?: string[]): Promise<AirlockLearningHostView[]> {
  if (only && only.length === 0) return [];
  const filter = only ? ` AND host IN (${only.map(() => '?').join(', ')})` : '';
  const policy = policyOf(view);
  const hosts: AirlockLearningHostView[] = [];
  const maxPages = Math.ceil(MAX_LEARNING_REPORTS_PER_ORG / LIST_PAGE) + 1;
  for (let page = 0; page < maxPages && hosts.length < AIRLOCK_PROPOSAL_LIMIT; page++) {
    const groups = await db.all<any>(
      `${GROUPS}${filter} ${RANKING} LIMIT ${LIST_PAGE} OFFSET ${page * LIST_PAGE}`,
      [orgId, ...(only ?? [])],
    );
    for (const g of groups) {
      if (learningExclusionOf(String(g.host), policy) || hosts.length >= AIRLOCK_PROPOSAL_LIMIT) continue;
      const proxyHits = Number(g.total_proxy ?? 0);
      hosts.push({
        host: String(g.host), installations: Number(g.installations), hits: Number(g.total_hits ?? 0), proxyHits,
        evidence: evidenceOf({ tool: 0, import: 0, proxy: proxyHits }), clients: [],
        firstSeen: iso(g.first_seen), lastSeen: iso(g.last_seen),
      });
    }
    if (groups.length < LIST_PAGE) break;
  }
  const page = hosts.slice(0, AIRLOCK_PROPOSAL_LIMIT);
  if (page.length) {
    // Clients, for the page only: a bounded IN list, no JSON aggregation in SQL.
    const byHost = new Map(page.map(h => [h.host, h]));
    const rows = await db.all<any>(
      `SELECT host, clients_json FROM airlock_learning_reports WHERE org_id = ? AND host IN (${page.map(() => '?').join(', ')})`,
      [orgId, ...page.map(h => h.host)],
    );
    for (const r of rows) {
      const h = byHost.get(String(r.host));
      if (!h) continue;
      for (const c of parseList(r.clients_json)) if (!h.clients.includes(c) && h.clients.length < MAX_LEARNED_CLIENTS) h.clients.push(c);
    }
  }
  return page;
}

/** The admin's list: the policy revision it was read at, and the proposed hosts. */
export async function listAirlockLearning(db: DB, orgId: string): Promise<{ revision: number; hosts: AirlockLearningHostView[] }> {
  const view = await getAirlockPolicy(db, orgId);
  return { revision: view.revision, hosts: (await proposedHosts(db, orgId, view)).slice(0, AIRLOCK_PROPOSAL_LIMIT) };
}

/**
 * An admin allows some of the proposed hosts: the next revision of the org's
 * policy, with only those added to its allow list. Refused (invalid_policy)
 * for a host the list does not offer, and (revision_conflict) when the policy
 * moved since the list was read.
 */
export async function acceptAirlockLearning(
  db: DB, orgId: string, hosts: unknown, expectedRevision: unknown, email: string | null,
): Promise<AirlockPolicyView> {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > AIRLOCK_PROPOSAL_LIMIT) {
    throw new AirlockPolicyError('invalid_policy', `hosts (1 to ${AIRLOCK_PROPOSAL_LIMIT} of the proposed hosts) is required`);
  }
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new AirlockPolicyError('invalid_policy', 'expectedRevision (the policy revision the list was read at) is required');
  }
  const view = await getAirlockPolicy(db, orgId);
  const asked = [...new Set(hosts.map(learnableHost).filter((h): h is string => h !== null))];
  const offered = new Set((await proposedHosts(db, orgId, view, asked)).map(h => h.host));
  const picked: string[] = [];
  const notOffered: string[] = [];
  for (const raw of hosts) {
    const host = learnableHost(raw);
    if (host && offered.has(host)) { if (!picked.includes(host)) picked.push(host); }
    else notOffered.push(String(raw).slice(0, 255));
  }
  if (notOffered.length) {
    throw new AirlockPolicyError('invalid_policy', 'Only proposed hosts the policy does not already cover can be allowed', notOffered.map(h => `${h}: not proposed`));
  }
  const { iocHosts: _ioc, ...policy } = withAcceptedHosts(policyOf(view), picked);
  return putAirlockPolicy(db, orgId, policy, expectedRevision, email);
}
