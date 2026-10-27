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
 */
import {
  airlockPolicyErrors,
  normalizeAirlockPolicy,
  DEFAULT_AIRLOCK_RULES,
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
  | { outcome: 'error'; error: string };

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

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.catch(() => undefined).then(fn);
  tail = run;
  return run;
}

/** The generation now: capture it when work for the current hub configuration begins. */
export function currentAirlockGeneration(): number {
  return generation;
}

/** The hub configuration changed: answers to syncs already in flight are not adopted. */
export function invalidateAirlockSyncs(): void {
  generation++;
}

// ── The answer ──────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the hub always sends; anything missing means the answer is not one to adopt. */
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
    const missing = Object.keys(DEFAULT_AIRLOCK_RULES).filter(k => typeof p.rules[k] !== 'string');
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
  const fail = (error: string): AirlockSyncOutcome => ({ outcome: 'error', error });
  /** Still the configuration this sync belongs to, and still the hub we are joined to. */
  const current = (): boolean => {
    if (generation !== startedIn) return false;
    if (!args.activeHubConfig) return true;
    const active = args.activeHubConfig();
    return !!active && airlockAuthorityOf(active) === authority;
  };
  // A caller that outlived its configuration does not even ask (its credential is the old one).
  if (!current()) return { outcome: 'superseded' };

  // Revalidate only what THIS authority gave us: never another org's ETag.
  const stored = await storage.getAirlockPolicy('hub');
  const mine = stored && stored.updatedBy === authority ? stored : null;
  const headers: Record<string, string> = { Authorization: `Bearer ${hubConfig.token}`, Accept: 'application/json' };
  if (mine?.etag) headers['If-None-Match'] = mine.etag;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${hubConfig.url.replace(/\/$/, '')}/v1/airlock/policy`, { method: 'GET', headers });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (res.status === 304) return { outcome: 'not-modified' };
  if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status}`);

  let body: any;
  try {
    body = await res.json();
  } catch {
    return fail('Invalid JSON from hub');
  }
  if (!isObject(body)) return fail('Hub returned a malformed Airlock answer');
  const etag = res.headers.get('etag');

  if (body.policy === null) {
    return exclusive(async () => {
      if (!current()) return { outcome: 'superseded' } as const;
      // This authority has no policy: a row another authority left is not its to keep in force.
      const stored = await storage.getAirlockPolicy('hub');
      if (stored && stored.updatedBy !== authority) {
        await storage.deleteAirlockPolicy('hub');
        await reconcileAirlockStateFile(storage, true, args.stateFile ?? defaultAirlockStateFile());
      }
      return { outcome: 'none' } as const;
    });
  }
  if (!isObject(body.policy)) return fail('Hub returned a malformed Airlock policy');
  const revision = body.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return fail('Hub returned an Airlock policy with no revision');
  }
  const incomplete = completenessErrors(body.policy);
  if (incomplete.length) return fail(`Hub returned an incomplete Airlock policy: ${incomplete.join('; ')}`);
  const errors = airlockPolicyErrors(body.policy);
  if (errors.length) return fail(`Hub returned an invalid Airlock policy: ${errors.join('; ')}`);
  const policy = normalizeAirlockPolicy(body.policy);
  const iocRevision = Number(policy.iocHosts.revision) || 0;

  return exclusive(async (): Promise<AirlockSyncOutcome> => {
    if (!current()) return { outcome: 'superseded' };
    const stored = await storage.getAirlockPolicy('hub');
    if (stored && stored.updatedBy === authority) {
      const older = revision < stored.revision
        || (revision === stored.revision && iocRevision < iocRevisionOf(stored));
      if (older) return { outcome: 'stale', revision, iocRevision };
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
    return { outcome: 'adopted', etag, revision };
  });
}

/**
 * One sync as the tick and `GET /airlock/policy?refresh=1` both run it:
 * logging a failure, announcing an adoption.
 */
export async function runAirlockSync(args: SyncAirlockPolicyArgs & {
  emit: (event: string, payload: any) => void;
}): Promise<AirlockSyncOutcome> {
  const out = await syncAirlockPolicy(args);
  if (out.outcome === 'error') console.error('[HUB_AIRLOCK] sync failed:', out.error);
  if (out.outcome === 'adopted') args.emit('airlock_policy_changed', { revision: out.revision, source: 'hub' });
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
