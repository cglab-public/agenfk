/**
 * Hub Airlock sync (GH-294, T3): pulls the org's Airlock policy from
 * `GET /v1/airlock/policy` and stores it as this installation's 'hub' row,
 * which outranks the local one (airlock/routes.ts resolveAirlockPolicy).
 *
 * Modelled on syncRepoSettings, with the guarantees a security policy needs:
 *  - a hub that is down, slow or wrong NEVER erases what is stored: every
 *    failure is an `error` outcome that writes nothing;
 *  - an answer is adopted only whole and complete. The policy must carry every
 *    field the hub always sends (mode, models, hosts, rules, iocHosts) and pass
 *    the shared validation; normalising a partial answer would quietly turn
 *    protection off;
 *  - the stored row belongs to one AUTHORITY (hub URL + org), recorded in its
 *    `updatedBy`. Its ETag is offered only back to that authority, so another
 *    org can never answer 304 to it, and after leaving the hub nothing is
 *    offered at all. Another authority's answer replaces the row outright
 *    (and its `{policy: null}` removes it: one org's policy is not another's);
 *  - within one authority an answer older than what is stored - by policy
 *    revision, then IOC revision - is refused (`stale`), so answers landing out
 *    of order cannot roll the protection back;
 *  - adoption and leaving the hub run one at a time under one lock, and every
 *    sync carries the configuration generation it started in: leaving the hub
 *    (or any hub config change, `invalidateAirlockSyncs`) supersedes the syncs
 *    still in flight, so a late answer cannot hand ownership back to a hub this
 *    installation has left.
 *
 * It is org-scoped: runFlowSyncTick calls it once per tick, projects or not.
 *
 * After each sync, runAirlockSync tells the hub what this installation applies
 * (HUB-2): the revision of the hub row it holds, and a hub policy it refused
 * as invalid. Each state is reported once per configuration, and again once
 * an hour (AIRLOCK_REPORT_RESEND_MS), so a report the hub never stored - an
 * outbox write that failed, a key bound to its machine only later - heals on
 * its own. The report is a side effect only: it runs after storage is
 * settled, and a report that fails changes nothing that is applied (it is
 * tried again on the next sync).
 */
import {
  airlockPolicyErrors,
  normalizeAirlockPolicy,
  type StorageProvider,
  type StoredAirlockPolicy,
} from '@agenfk/core';
import { reconcileAirlockStateFile, defaultAirlockStateFile, type StateFileResult } from '../airlock/routes.js';
import type { HubConfig } from './types.js';
import type { FetchLike } from './flowSync.js';

export type AirlockSyncOutcome =
  | { outcome: 'adopted'; etag: string | null; revision: number }
  | { outcome: 'not-modified' }
  | { outcome: 'none' }
  | { outcome: 'stale'; revision: number; iocRevision: number }
  | { outcome: 'superseded' }
  /** `refused`: the hub answered, and its answer was not one to adopt (malformed, incomplete or invalid). */
  | { outcome: 'error'; error: string; refused?: { revision: number | null; iocRevision: number | null } };

/**
 * What the installation tells the hub it applies; the server sends it through
 * its hub event outbox. A reporter returning false did not enqueue it.
 */
export type AirlockApplyReport =
  | { type: 'airlock.policy-applied'; payload: { revision: number; iocRevision: number } }
  | { type: 'airlock.policy-refused'; payload: { revision: number | null; iocRevision: number | null; error: string } };

/** Sends one report; false when it could not be enqueued. */
export type AirlockApplyReporter = (r: AirlockApplyReport) => boolean | void;

export interface SyncAirlockPolicyArgs {
  storage: StorageProvider;
  hubConfig: HubConfig;
  fetchImpl: FetchLike;
  /** Where the adapters' cold-start copy lives; the default is ~/.agenfk/airlock-state.json. */
  stateFile?: string;
  /**
   * The configuration generation the CALLER began under (currentAirlockGeneration).
   * A tick captures it before its first await, so a tick that outlives a
   * repoint or a logout neither starts nor adopts a sync. Default: now.
   */
  generation?: number;
  /** The hub this installation is joined to now; adoption is refused when it is another authority. */
  activeHubConfig?: () => Pick<HubConfig, 'url' | 'orgId'> | null;
}

/** Who a stored hub row came from: the hub's address and the org. Kept in the row's `updatedBy`. */
export function airlockAuthorityOf(hubConfig: Pick<HubConfig, 'url' | 'orgId'>): string {
  return `hub ${hubConfig.url.replace(/\/+$/, '').toLowerCase()} org ${hubConfig.orgId}`;
}

// ── One at a time, and only for the configuration it started in ─────────────

let generation = 0;
let tail: Promise<unknown> = Promise.resolve();
/** How long a reported state goes before it is sent again: twelve flow-sync ticks at the default 5 minutes. */
export const AIRLOCK_REPORT_RESEND_MS = 60 * 60 * 1000;

type Sent = { key: string; at: number } | null;
/** The last state reported, per kind, and when: a state is sent once per interval, not once per tick. */
let lastReported: { applied: Sent; refused: Sent } = { applied: null, refused: null };

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.catch(() => undefined).then(fn);
  tail = run;
  return run;
}

/** The generation now: capture it when work for the current hub configuration begins. */
export function currentAirlockGeneration(): number {
  return generation;
}

/**
 * The hub's dataset switch (DS-1), as its last adopted answer said: off until a hub
 * says on, kept over a 304, and off again after a failed or refused sync or whenever
 * the hub configuration changes. An answer without it (a hub from before the dataset) is off.
 */
let datasetEnabled = false;
/** Syncs started, and the latest whose answer set the switch: an answer from an earlier-started sync never overrides a later one's. */
let syncsStarted = 0;
let datasetDecidedBy = 0;
/** The ETag of the answer the switch came from: only that one may be revalidated (a 304 keeps the switch as it is). */
let datasetEtag: string | null = null;
export function airlockDatasetEnabled(): boolean {
  return datasetEnabled;
}
/**
 * Off because a sync said so (an answer, a failed sync, a new hub configuration) -
 * not merely because none has answered yet since this process started: rows queued
 * while it was on are dropped from the outbox only then (story review F1).
 */
export function airlockDatasetDecidedOff(): boolean {
  return !datasetEnabled && datasetDecidedBy > 0;
}
const setDataset = (seq: number, on: boolean, etag: string | null): void => {
  if (seq < datasetDecidedBy) return;
  datasetDecidedBy = seq;
  datasetEnabled = on;
  datasetEtag = etag;
};
const datasetOf = (body: Record<string, any>): boolean => isObject(body.dataset) && body.dataset.enabled === true;

/** The hub configuration changed: answers to syncs already in flight are not adopted. */
export function invalidateAirlockSyncs(): void {
  generation++;
  datasetEnabled = false;
  datasetDecidedBy = syncsStarted;
  datasetEtag = null;
  // Whichever hub this installation answers to now has heard nothing from it yet.
  lastReported = { applied: null, refused: null };
}

// ── The answer ──────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the hub always sends; anything missing means the answer is not one to adopt. */
/**
 * The rules every hub sends. A rule added later (publishThroughAllowedHost,
 * c9bdbe61) is absent from a hub on an earlier release: that hub never decided
 * on it, so it takes its default instead of the whole policy being refused.
 */
const HUB_REQUIRED_RULES = ['uploadToUnlistedHost', 'credentialReadWithNetwork', 'namespaceEscape', 'cloudMutation'] as const;

function completenessErrors(p: Record<string, any>): string[] {
  const errors: string[] = [];
  if (typeof p.mode !== 'string') errors.push('mode is missing');
  if (!Array.isArray(p.models)) errors.push('models is missing');
  if (typeof p.appliesWhenModelUnknown !== 'boolean') errors.push('appliesWhenModelUnknown is missing');
  if (!isObject(p.hosts) || !Array.isArray(p.hosts.allow) || !Array.isArray(p.hosts.deny)) errors.push('hosts is incomplete');
  if (!isObject(p.iocHosts) || typeof p.iocHosts.revision !== 'string' || !Array.isArray(p.iocHosts.hosts)) {
    errors.push('iocHosts is incomplete');
  }
  if (!isObject(p.rules)) errors.push('rules is missing');
  else {
    const missing = HUB_REQUIRED_RULES.filter(k => typeof p.rules[k] !== 'string');
    if (missing.length) errors.push(`rules is missing ${missing.join(', ')}`);
  }
  return errors;
}

const iocRevisionOf = (row: StoredAirlockPolicy): number => {
  const n = Number(row.policy.iocHosts.revision);
  return Number.isFinite(n) ? n : 0;
};

export async function syncAirlockPolicy(args: SyncAirlockPolicyArgs): Promise<AirlockSyncOutcome> {
  const { storage, hubConfig, fetchImpl } = args;
  const startedIn = args.generation ?? generation;
  const authority = airlockAuthorityOf(hubConfig);
  /** This sync's place in the order syncs started (0 until it asks the hub). */
  let seq = 0;
  /**
   * A sync that failed or was refused turns the dataset switch off (story review F1):
   * capture stays on only while the hub keeps saying so, never on an answer that
   * could not be read - the switch an admin turned off reaches no further than that.
   */
  const datasetOffUnlessSuperseded = (): void => {
    if (seq && current()) setDataset(seq, false, null);
  };
  const fail = (error: string): AirlockSyncOutcome => {
    datasetOffUnlessSuperseded();
    return { outcome: 'error', error };
  };
  /** The state the hub offered and this installation refused: its policy revision and its IOC revision. */
  let offeredIoc: number | null = null;
  const refuse = (error: string, revision: number | null): AirlockSyncOutcome => {
    datasetOffUnlessSuperseded();
    return { outcome: 'error', error, refused: { revision, iocRevision: offeredIoc } };
  };
  /** Still the configuration this sync belongs to, and still the hub we are joined to. */
  const current = (): boolean => {
    if (generation !== startedIn) return false;
    if (!args.activeHubConfig) return true;
    const active = args.activeHubConfig();
    return !!active && airlockAuthorityOf(active) === authority;
  };
  // A caller that outlived its configuration does not even ask (its credential is the old one).
  if (!current()) return { outcome: 'superseded' };
  seq = ++syncsStarted;

  // Revalidate only what THIS authority gave us: never another org's ETag.
  const stored = await storage.getAirlockPolicy('hub');
  const mine = stored && stored.updatedBy === authority ? stored : null;
  const headers: Record<string, string> = { Authorization: `Bearer ${hubConfig.token}`, Accept: 'application/json' };
  // Only when the dataset switch in memory came from that same answer: a fresh process
  // (or a new hub configuration) reads the answer whole, switch and all (DS-1).
  // The switch that ETag stands for, as the request is made: what a 304 confirms.
  const revalidated = mine?.etag && mine.etag === datasetEtag ? { on: datasetEnabled, etag: datasetEtag } : null;
  if (revalidated) headers['If-None-Match'] = mine!.etag!;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${hubConfig.url.replace(/\/$/, '')}/v1/airlock/policy`, { method: 'GET', headers });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (res.status === 304) {
    // Revalidated: a decision too, so an earlier-started sync answered later cannot override it.
    if (current() && revalidated) setDataset(seq, revalidated.on, revalidated.etag);
    return { outcome: 'not-modified' };
  }
  if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status}`);

  let body: any;
  try {
    body = await res.json();
  } catch {
    return fail('Invalid JSON from hub');
  }
  if (!isObject(body)) return refuse('Hub returned a malformed Airlock answer', null);
  // The hub sends the IOC revision beside the policy (and inside it); the refusal names it, so
  // an apply of the IOC list still held cannot be taken for an answer to it.
  const iocOf = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  };
  offeredIoc = iocOf(body.iocRevision) ?? (isObject(body.policy) && isObject(body.policy.iocHosts) ? iocOf(body.policy.iocHosts.revision) : null);
  const etag = res.headers.get('etag');

  if (body.policy === null) {
    return exclusive(async () => {
      if (!current()) return { outcome: 'superseded' } as const;
      setDataset(seq, datasetOf(body), null);
      // This authority has no policy: a row another authority left is not its to keep in force.
      const stored = await storage.getAirlockPolicy('hub');
      if (stored && stored.updatedBy !== authority) {
        await storage.deleteAirlockPolicy('hub');
        await reconcileAirlockStateFile(storage, true, args.stateFile ?? defaultAirlockStateFile());
      }
      return { outcome: 'none' } as const;
    });
  }
  const revision = body.revision;
  const wholeRevision = typeof revision === 'number' && Number.isInteger(revision) && revision >= 1;
  if (!isObject(body.policy)) return refuse('Hub returned a malformed Airlock policy', wholeRevision ? revision : null);
  if (!wholeRevision) return refuse('Hub returned an Airlock policy with no revision', null);
  const incomplete = completenessErrors(body.policy);
  if (incomplete.length) return refuse(`Hub returned an incomplete Airlock policy: ${incomplete.join('; ')}`, revision);
  const errors = airlockPolicyErrors(body.policy);
  if (errors.length) return refuse(`Hub returned an invalid Airlock policy: ${errors.join('; ')}`, revision);
  const policy = normalizeAirlockPolicy(body.policy);
  const iocRevision = Number(policy.iocHosts.revision) || 0;

  return exclusive(async (): Promise<AirlockSyncOutcome> => {
    if (!current()) return { outcome: 'superseded' };
    const stored = await storage.getAirlockPolicy('hub');
    if (stored && stored.updatedBy === authority) {
      const older = revision < stored.revision
        || (revision === stored.revision && iocRevision < iocRevisionOf(stored));
      if (older) {
        // The policy is not taken back to an older revision, but the dataset switch is
        // the hub's word now, whatever revision it came with (story review, second
        // pass): a hub restored from a backup that says off is off.
        setDataset(seq, datasetOf(body), null);
        return { outcome: 'stale', revision, iocRevision };
      }
    }
    await storage.putAirlockPolicy({
      scope: 'hub',
      revision,
      policy,
      updatedAt: new Date().toISOString(),
      updatedBy: authority,
      authority: 'hub',
      etag,
    }, stored ? stored.revision : 0);
    await reconcileAirlockStateFile(storage, true, args.stateFile ?? defaultAirlockStateFile());
    setDataset(seq, datasetOf(body), etag);
    return { outcome: 'adopted', etag, revision };
  });
}

/** Longest refusal reason sent to the hub: the validation list can be long, the hub keeps a summary. */
const MAX_REPORTED_ERROR = 500;

/**
 * Tell the hub what this installation applies after a sync: the hub row it
 * holds from this authority (adopted, revalidated or kept over a stale or
 * refused answer), and the refusal. A transport failure, a superseded sync and
 * a hub with no policy say nothing new, so they report nothing.
 */
async function reportApplied(
  args: SyncAirlockPolicyArgs, out: AirlockSyncOutcome, report: AirlockApplyReporter,
): Promise<void> {
  const refused = out.outcome === 'error' ? out.refused : undefined;
  if (!['adopted', 'not-modified', 'stale'].includes(out.outcome) && !refused) return;
  const authority = airlockAuthorityOf(args.hubConfig);
  const send = (kind: 'applied' | 'refused', key: string, r: AirlockApplyReport): void => {
    const last = lastReported[kind];
    const now = Date.now();
    if (last && last.key === key && now - last.at < AIRLOCK_REPORT_RESEND_MS) return;
    try {
      // Recorded as sent only once it is enqueued: otherwise the next sync sends it again.
      if (report(r) !== false) lastReported[kind] = { key, at: now };
    } catch (e) {
      // Left unrecorded, so the next sync sends it again; what is applied is untouched.
      console.error('[HUB_AIRLOCK] could not report to the hub:', (e as Error).message);
    }
  };
  const stored = await args.storage.getAirlockPolicy('hub');
  if (stored && stored.updatedBy === authority) {
    const iocRevision = iocRevisionOf(stored);
    send('applied', `${authority} ${stored.revision}:${iocRevision}`,
      { type: 'airlock.policy-applied', payload: { revision: stored.revision, iocRevision } });
  }
  if (refused && out.outcome === 'error') {
    const error = out.error.slice(0, MAX_REPORTED_ERROR);
    send('refused', `${authority} ${refused.revision}:${refused.iocRevision} ${error}`,
      { type: 'airlock.policy-refused', payload: { revision: refused.revision, iocRevision: refused.iocRevision, error } });
  }
}

/**
 * One sync as the tick and `GET /airlock/policy?refresh=1` both run it:
 * logging a failure, announcing an adoption, and - given `report` - telling
 * the hub what is applied.
 */
export async function runAirlockSync(args: SyncAirlockPolicyArgs & {
  emit: (event: string, payload: any) => void;
  report?: AirlockApplyReporter;
}): Promise<AirlockSyncOutcome> {
  const startedIn = args.generation ?? generation;
  const out = await syncAirlockPolicy(args);
  if (out.outcome === 'error') console.error('[HUB_AIRLOCK] sync failed:', out.error);
  if (out.outcome === 'adopted') args.emit('airlock_policy_changed', { revision: out.revision, source: 'hub' });
  // A sync that outlived its configuration speaks for a hub this installation no longer answers to.
  if (args.report && generation === startedIn) {
    try {
      await reportApplied(args, out, args.report);
    } catch (e) {
      console.error('[HUB_AIRLOCK] could not report to the hub:', (e as Error).message);
    }
  }
  return out;
}

export interface ReleaseHubAirlockArgs {
  storage: StorageProvider;
  stateFile?: string;
}

/**
 * Leaving the hub: the hub row becomes the local row (the next local revision)
 * in one storage transaction, so the policy stays in force and becomes
 * editable here. Supersedes every sync in flight first, and runs under the
 * same lock as adoption, so nothing adopted afterwards can bring the hub back.
 */
export async function releaseHubAirlockPolicy(args: ReleaseHubAirlockArgs): Promise<{ released: boolean; stateFile?: StateFileResult }> {
  invalidateAirlockSyncs();
  return exclusive(async () => {
    const { storage } = args;
    const hub = await storage.getAirlockPolicy('hub');
    if (!hub) return { released: false };
    const local = await storage.releaseAirlockHubPolicy(hub.revision, {
      updatedAt: new Date().toISOString(),
      updatedBy: `${hub.updatedBy} (revision ${hub.revision}, kept on leaving the hub)`,
    });
    if (!local) return { released: false };
    const stateFile = await reconcileAirlockStateFile(storage, false, args.stateFile ?? defaultAirlockStateFile());
    return { released: true, stateFile };
  });
}
