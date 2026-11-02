/**
 * Airlock learning mode (GH-294, TEL-3): what sessions reached, as a proposed
 * allowlist a person accepts.
 *
 *   GET  /airlock/learning           the proposal, and the policy it was made against
 *   POST /airlock/learning/import    host names, counts and context from a pi session-log import (CLI); loopback only
 *   POST /airlock/learning/accept    a person allows some of the proposed hosts, on the board (standalone)
 *   POST /airlock/learning/forward   a person sends some of them to the hub, on the board (hub-joined)
 *
 * LEARNING: every host a tool call reaches (POST /airlock/evaluate, not a dry
 * run) and every host the sandbox proxy reports is learned, in any mode, off
 * included: the point is to have an allowlist before turning enforce on. Only
 * the host is kept - never the command, the URL's path or query - and a host
 * that redaction would change (a secret as a DNS label), as written or as
 * learned, is not kept at all. Nor is a host the policy would never propose
 * (metadata, IOC, denied, allowed, private). Retention goes by this server's
 * receipt time; a date a caller reports is only shown, clamped to now.
 * Learning never fails or delays a verdict beyond its own write, and an error
 * in it is logged, not returned.
 *
 * CONTEXT (user decisions 2026-11-02): an import entry may carry what the
 * importing machine knew of the host - the projects that reached it, an
 * address's reverse DNS name, and a model-written hint when the person asked
 * for one (--hints). It is shown beside the host, never used to decide, and
 * kept only as core sanitizeHostContext cleans it: those four fields, bounded,
 * one line each, any field the redaction would change dropped.
 *
 * ACCEPTING (user decision 2026-10-27) is a person's act, never automatic:
 *  - only from the board (x-agenfk-ui: 1) and never with the agent's
 *    x-agenfk-internal header, so the CLI and MCP can never accept or forward;
 *  - standalone: the accepted hosts are added to the allow list as the next
 *    local revision, compare-and-swapped on the revision the person read, like
 *    PUT /airlock/policy;
 *  - hub-joined: the hub owns the policy, so accept is 409
 *    HUB_OWNS_AIRLOCK_POLICY and the person forwards the proposal instead, as
 *    an airlock.learning-proposal outbox event (host names and counts, no card
 *    ids); an org admin accepts it on Admin -> Airlock;
 *  - only a host the current proposal offers can be accepted or forwarded, so
 *    a metadata endpoint, an IOC host, a denied host or a private address
 *    never reaches an allow list this way.
 */
import * as os from 'os';
import { getDomain } from 'tldts';
import {
  AIRLOCK_PROPOSAL_LIMIT,
  sightingsOfCapabilities,
  learnableHost,
  learnRawHost,
  learningExclusionOf,
  sanitizeHostContext,
  EMPTY_HOST_CONTEXT,
  type AirlockHostScreen,
  proposeAllowlist,
  withAcceptedHosts,
  type AirlockAcceptedEntry,
  type AirlockHostObservation,
  type AirlockLearnSource,
  type AirlockPolicy,
  type AirlockProposedHost,
  type Capability,
  type HubEventType,
  type StorageProvider,
  type StoredAirlockPolicy,
} from '@agenfk/core';

/** Hosts one import request may carry (the CLI sends batches of at most this many). */
export const MAX_LEARNING_IMPORT_HOSTS = 1000;
/** The most one import entry may claim: a count, not a payload. */
const MAX_IMPORT_HITS = 1_000_000_000;
const CLIENTS: readonly string[] = ['pi', 'opencode'];
const DIRECTIONS: readonly string[] = ['download', 'upload', 'both'];

/** A host's registrable domain by the public suffix list, private section included (a vercel.app site is its own). */
export const registrableDomain = (host: string): string | null => getDomain(host, { allowPrivateDomains: true });

/** What the learning routes need of the policy view (routes.ts AirlockPolicyView). */
interface PolicyView {
  effective: AirlockPolicy;
  source: 'hub' | 'local';
  revision: number;
  hubManaged: boolean;
}

export interface AirlockLearningDeps {
  storage: () => StorageProvider;
  hubJoined: () => boolean;
  recordHubEvent: (event: { type: HubEventType; payload: Record<string, unknown> }) => unknown;
  emit: (event: string, payload?: unknown) => void;
  now: () => number;
  resolvePolicy: () => Promise<PolicyView>;
  /** Rewrite the adapters' cold-start state file; never throws. */
  writeStateFile: (view: PolicyView) => unknown;
  /** The decision log's redaction: a host it would change is not learned. */
  redact: (text: string) => string;
  /**
   * The redaction for text that is not a shell command: a context's hint or
   * project name it would change carries a secret. (The shell-word redaction
   * reads an apostrophe in prose as a quote it removes.)
   */
  redactPlain: (text: string) => string;
}

export interface AirlockLearning {
  /** The hosts a judged tool call reaches. Never throws. */
  observeTool: (capabilities: readonly Capability[], client: string, itemId: string | null) => Promise<void>;
  /** The hosts a proxy report named. Never throws. */
  observeProxy: (hosts: readonly string[], client: string, itemId: string | null) => Promise<void>;
}

/** Accept and forward are a person's, on the board: never the agent's. */
function refuseUnlessBoard(req: any, res: any): boolean {
  if (req.headers?.['x-agenfk-internal'] !== undefined || req.headers?.['x-agenfk-ui'] !== '1') {
    res.status(403).json({ error: 'An Airlock allowlist proposal is accepted by a person on the board (agenfk ui), never by an agent.' });
    return true;
  }
  return false;
}

const isLoopback = (addr: string | undefined): boolean =>
  !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function registerAirlockLearning(app: any, deps: AirlockLearningDeps): AirlockLearning {
  /**
   * Does a host carry a secret? Asked of the spelling AS WRITTEN (secret
   * formats are case-sensitive, and the parsers lowercase) and of the learned
   * form: the decision log's redaction, which also knows this machine's
   * secret env values.
   */
  const carriesSecret: AirlockHostScreen = (spelling) => deps.redact(spelling) !== spelling;
  const proseCarriesSecret: AirlockHostScreen = (text) => deps.redactPlain(text) !== text;

  /**
   * A host handed over on its own (a proxy report, an import entry) as it may
   * be kept: the string as given, screened as written (numeric spellings
   * too), learned only when it IS the host up to ASCII case or a numeric
   * address (learnRawHost), and screened again as learned.
   */
  const keepable = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const host = learnRawHost(raw, carriesSecret);
    return host && !carriesSecret(host) ? host : null;
  };

  /** Hosts the policy would never propose are never stored either (they would only take room). */
  const notExcluded = (policy: AirlockPolicy) => (host: string) => learningExclusionOf(host, policy) === null;

  const observe = async (
    sightingsOf: () => ReadonlyArray<{ host: string; upload: boolean }>, source: AirlockLearnSource, client: string, itemId: string | null,
  ): Promise<void> => {
    try {
      const at = new Date(deps.now()).toISOString();
      const keep = notExcluded((await deps.resolvePolicy()).effective);
      const observations: AirlockHostObservation[] = [];
      const seen = new Set<string>();
      for (const { host: raw, upload } of sightingsOf()) {
        const host = keepable(raw);
        if (!host || seen.has(host) || !keep(host)) continue;
        seen.add(host);
        observations.push({ host, source, client, itemId, ts: at, receivedAt: at, ...(upload ? { uploads: 1 } : {}) });
      }
      if (observations.length) await deps.storage().recordAirlockHostObservations(observations);
    } catch (e) {
      console.error('[AIRLOCK] could not learn the hosts of a decision:', (e as Error).message);
    }
  };

  /** The whole proposal (uncapped), for deciding what may be accepted. */
  const proposalOf = async (view: PolicyView) =>
    proposeAllowlist(await deps.storage().listAirlockLearnedHosts(), view.effective, { limit: Number.MAX_SAFE_INTEGER });

  /**
   * The requested hosts, each one the proposal offers, or a 400 already sent.
   * Answered as the proposal names them, in the order asked.
   */
  const requestedHosts = async (req: any, res: any, view: PolicyView): Promise<AirlockProposedHost[] | null> => {
    const raw = req.body?.hosts;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > AIRLOCK_PROPOSAL_LIMIT) {
      res.status(400).json({ error: `hosts (1 to ${AIRLOCK_PROPOSAL_LIMIT} of the proposed hosts) is required` });
      return null;
    }
    const offered = new Map((await proposalOf(view)).hosts.map(h => [h.host, h]));
    const picked: AirlockProposedHost[] = [];
    const notOffered: string[] = [];
    for (const r of raw) {
      const host = learnableHost(r);
      const p = host ? offered.get(host) : undefined;
      if (!p) notOffered.push(String(r).slice(0, 255));
      else if (!picked.includes(p)) picked.push(p);
    }
    if (notOffered.length) {
      res.status(400).json({
        error: 'AIRLOCK_HOST_NOT_PROPOSED',
        message: 'Only hosts the proposal offers can be accepted: never one the policy denies, lists as an IOC, already allows, a metadata endpoint or a private address.',
        hosts: notOffered,
      });
      return null;
    }
    return picked;
  };

  /**
   * What a person accepts: `entries` ({ pattern, direction }), each a host or a
   * wildcard the proposal offers - or `hosts`, both ways, as before. Answered
   * with the entries and the proposed hosts they cover, or a 400 already sent.
   */
  const requestedEntries = async (req: any, res: any, view: PolicyView): Promise<{ entries: AirlockAcceptedEntry[]; hosts: AirlockProposedHost[] } | null> => {
    const raw = req.body?.entries;
    if (raw === undefined) {
      const hosts = await requestedHosts(req, res, view);
      return hosts && { entries: hosts.map(h => ({ pattern: h.host, direction: 'both' as const })), hosts };
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > AIRLOCK_PROPOSAL_LIMIT) {
      res.status(400).json({ error: `entries (1 to ${AIRLOCK_PROPOSAL_LIMIT} of the proposed hosts or wildcards, each with a direction) is required` });
      return null;
    }
    const learned = await deps.storage().listAirlockLearnedHosts();
    const hostsBy = new Map(proposeAllowlist(learned, view.effective, { limit: Number.MAX_SAFE_INTEGER }).hosts.map(h => [h.host, h]));
    // Wildcards as GET /airlock/learning offers them: over the capped list the person saw.
    const wildcards = new Map(proposeAllowlist(learned, view.effective, { registrableDomain }).wildcards.map(w => [w.pattern, w]));
    const entries: AirlockAcceptedEntry[] = [];
    const covered = new Map<string, AirlockProposedHost>();
    const refused: string[] = [];
    for (const e of raw) {
      const pattern = typeof e?.pattern === 'string' ? e.pattern.trim().toLowerCase() : '';
      const direction = e?.direction;
      const host = hostsBy.get(learnableHost(pattern) ?? '');
      const wildcard = wildcards.get(pattern);
      if (!DIRECTIONS.includes(direction) || (!host && !wildcard)) {
        refused.push(String(e?.pattern ?? '').slice(0, 255));
        continue;
      }
      entries.push({ pattern: host ? host.host : pattern, direction });
      for (const h of host ? [host.host] : wildcard!.hosts) covered.set(h, hostsBy.get(h)!);
    }
    if (refused.length) {
      res.status(400).json({
        error: 'AIRLOCK_HOST_NOT_PROPOSED',
        message: 'Only hosts and wildcards the proposal offers can be accepted, each for downloads, uploads or both.',
        hosts: refused,
      });
      return null;
    }
    return { entries, hosts: [...covered.values()] };
  };

  app.get('/airlock/learning', async (_req: any, res: any, next: any) => {
    try {
      const view = await deps.resolvePolicy();
      const proposal = proposeAllowlist(await deps.storage().listAirlockLearnedHosts(), view.effective, { registrableDomain });
      res.json({ proposal, revision: view.revision, source: view.source, hubManaged: view.hubManaged, hubJoined: deps.hubJoined() });
    } catch (e) { next(e); }
  });

  app.post('/airlock/learning/import', async (req: any, res: any, next: any) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        return res.status(403).json({ error: 'An Airlock learning import is only accepted from this machine' });
      }
      const body = req.body ?? {};
      if (!CLIENTS.includes(body.client)) return res.status(400).json({ error: `client must be one of ${CLIENTS.join(', ')}` });
      const list = body.hosts;
      if (!Array.isArray(list)) return res.status(400).json({ error: 'hosts (an array of { host, hits, uploads, firstSeen, lastSeen, context }) is required' });
      if (list.length > MAX_LEARNING_IMPORT_HOSTS) {
        return res.status(400).json({ error: `an import may carry at most ${MAX_LEARNING_IMPORT_HOSTS} hosts; this one has ${list.length}` });
      }
      const at = new Date(deps.now()).toISOString();
      const keep = notExcluded((await deps.resolvePolicy()).effective);
      const observations: AirlockHostObservation[] = [];
      let invalid = 0;
      let excluded = 0;
      // Only these six fields are read, the context through its own cleaning: whatever else an entry carries is never kept.
      // The dates are the sender's: shown, clamped to now (mergeHostObservation),
      // never what retention goes by - that is receivedAt, this server's clock.
      for (const d of list) {
        const host = d && typeof d === 'object' ? keepable(d.host) : null;
        const hits = d?.hits;
        // How many of the hits sent the host data: absent is none, never more than the hits.
        const uploads = d?.uploads ?? 0;
        if (!host || !Number.isInteger(hits) || hits < 1 || hits > MAX_IMPORT_HITS || !Number.isInteger(uploads) || uploads < 0 || uploads > hits) {
          invalid++;
          continue;
        }
        if (!keep(host)) {
          excluded++;
          continue;
        }
        const lastSeen = isoOrNull(d.lastSeen) ?? at;
        observations.push({
          host, source: 'import', client: body.client, ts: lastSeen, hits, uploads, firstSeen: isoOrNull(d.firstSeen) ?? lastSeen, receivedAt: at,
          // A context the importer sent, even an empty one, is its snapshot (it clears a stale one);
          // none at all is an importer from before contexts, which leaves the stored one as it was.
          context: d.context === undefined ? undefined : sanitizeHostContext(d.context, proseCarriesSecret) ?? EMPTY_HOST_CONTEXT,
        });
      }
      if (observations.length) {
        await deps.storage().recordAirlockHostObservations(observations);
        deps.emit('airlock_learning_changed', { source: 'import' });
      }
      // hubJoined: the CLI names the next step, accepting here or sending to the hub.
      res.json({ recorded: observations.length, invalid, excluded, hubJoined: deps.hubJoined() });
    } catch (e) { next(e); }
  });

  app.post('/airlock/learning/accept', async (req: any, res: any, next: any) => {
    try {
      if (refuseUnlessBoard(req, res)) return;
      const storage = deps.storage();
      const view = await deps.resolvePolicy();
      if (view.hubManaged) {
        deps.recordHubEvent({ type: 'airlock.local-write-refused', payload: { source: view.source, revision: view.revision, via: 'learning' } });
        return res.status(409).json({
          error: 'HUB_OWNS_AIRLOCK_POLICY',
          message: 'The Airlock policy is managed by your organization\'s hub and cannot be changed on this installation. Send the proposal to the hub instead; an org admin accepts it there.',
        });
      }
      const expected = req.body?.expectedRevision;
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
        return res.status(400).json({ error: 'expectedRevision (the policy revision the proposal was read at) is required' });
      }
      const asked = await requestedEntries(req, res, view);
      if (!asked) return;
      const { entries, hosts: picked } = asked;
      const policy = withAcceptedHosts(view.effective, entries);
      let stored: StoredAirlockPolicy;
      try {
        stored = await storage.putAirlockPolicy({
          scope: 'local',
          revision: expected + 1,
          policy,
          updatedAt: new Date(deps.now()).toISOString(),
          updatedBy: os.userInfo().username,
          authority: 'local',
        }, expected);
      } catch (e: any) {
        if (e?.code === 'AIRLOCK_STALE_REVISION') {
          return res.status(409).json({
            error: 'AIRLOCK_REVISION_CONFLICT',
            message: `The policy changed since the proposal was read: it is at revision ${e.currentRevision}, not ${expected}. Reload the proposal and accept again.`,
            currentRevision: e.currentRevision,
          });
        }
        throw e;
      }
      const after = await deps.resolvePolicy();
      const stateFile = deps.writeStateFile(after);
      deps.recordHubEvent({ type: 'airlock.policy-changed', payload: { revision: stored.revision, mode: policy.mode, scope: 'local', via: 'learning', added: entries.length } });
      deps.emit('airlock_policy_changed', { revision: after.revision, source: after.source });
      deps.emit('airlock_learning_changed', { accepted: picked.length });
      res.json({ ...after, accepted: entries.map(e => e.pattern), covered: picked.map(h => h.host), stateFile });
    } catch (e) { next(e); }
  });

  app.post('/airlock/learning/forward', async (req: any, res: any, next: any) => {
    try {
      if (refuseUnlessBoard(req, res)) return;
      if (!deps.hubJoined()) {
        return res.status(409).json({ error: 'NOT_HUB_JOINED', message: 'This installation is not joined to a hub: accept the proposal here instead.' });
      }
      const view = await deps.resolvePolicy();
      const picked = await requestedHosts(req, res, view);
      if (!picked) return;
      // Host names, counts and the import's context: no card ids, no commands, no URLs.
      const hosts = picked.map(h => ({
        host: h.host, hits: h.hits, uploads: h.uploads, sources: h.sources, evidence: h.evidence, clients: h.clients,
        firstSeen: h.firstSeen, lastSeen: h.lastSeen, cardCount: h.cards.length, context: h.context,
      }));
      deps.recordHubEvent({ type: 'airlock.learning-proposal', payload: { hosts, revision: view.revision } });
      res.json({ forwarded: hosts.length });
    } catch (e) { next(e); }
  });

  return {
    observeTool: (capabilities, client, itemId) => observe(() => sightingsOfCapabilities(capabilities, carriesSecret), 'tool', client, itemId),
    // The proxy cannot see which way data goes.
    observeProxy: (hosts, client, itemId) => observe(() => hosts.map(host => ({ host, upload: false })), 'proxy', client, itemId),
  };
}
