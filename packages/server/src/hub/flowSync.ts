/**
 * Hub flow reconciler — pulls the org's currently-assigned flow from the corp
 * Hub and reconciles it into local storage with `source = 'hub'`.
 *
 * Two layers:
 *  - `reconcileProjectFlow()` does one round-trip for one (optional) projectId.
 *  - `flowSyncChannels()` iterates the locally-known projects and calls the
 *    above for each, threading a per-project ETag cache, beside the Airlock and
 *    receipt channels. The hub loop in `hubSync.ts` runs them (GH-346).
 */
import { randomUUID } from 'crypto';
import type { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { Flow } from '@agenfk/core';
import { flowChecksErrors, normalizeFlowSteps } from '@agenfk/core';
import type { HubConfig } from './types.js';
import { syncRepoSettings, declaredVerifyCommand } from './repoSettingsSync.js';
import { publishPendingReceipts } from './receiptPublisher.js';
import { runAirlockSync, currentAirlockGeneration, type AirlockApplyReporter } from './airlockSync.js';
import type { HubSyncChannel } from './hubSync.js';

export type FetchLike = (url: string, opts: any) => Promise<{
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  json: () => Promise<any>;
}>;

export interface ReconcileProjectArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  /** Project to fetch the effective flow for. Pass null/undefined for org-fallback.
   *  Used only for the LOCAL rebind + mutex key; the hub is keyed on the repo. */
  projectId: string | null;
  /** Raw git remote URL for the project. When present, the hub is queried by
   *  repo (?repo=); otherwise it falls back to the legacy ?projectId= key. */
  remoteUrl?: string | null;
  /** ETag from the last successful pull for this project. */
  lastEtag: string | null;
  fetchImpl: FetchLike;
  /** Fired with ('flow:updated', { flowId, projectId? }) on successful upsert. */
  emit: (event: string, payload: any) => void;
}

export type ReconcileOutcome =
  | { outcome: 'updated'; etag: string | null; localFlowId: string }
  | { outcome: 'not-modified'; etag: string | null }
  | { outcome: 'no-assignment'; etag: string | null }
  | { outcome: 'error'; etag: string | null; error: string };

// ── Per-project serialization ───────────────────────────────────────────────
// The reconcile does a read-modify-write (listFlows → find by hubFlowId →
// create/update → rebind project) with `await` gaps. Two callers now drive it:
// the polling loop AND on-demand refreshes (GET .../flow?refresh=true). Without
// serialization, two concurrent reconciles for the same project could both see
// "no existing row", both createFlow with a fresh uuid, and leave duplicate rows
// for the same hubFlowId. This lightweight chained-promise mutex, keyed by
// project, guarantees the critical section runs one-at-a-time per project.
const reconcileLocks = new Map<string, Promise<unknown>>();

async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = reconcileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous holder settles, either way
  const guard = run.then(() => undefined, () => undefined); // never rejects → chain survives throws
  reconcileLocks.set(key, guard);
  try {
    return await run;
  } finally {
    if (reconcileLocks.get(key) === guard) reconcileLocks.delete(key);
  }
}

export function reconcileProjectFlow(args: ReconcileProjectArgs): Promise<ReconcileOutcome> {
  // One key per project; the org-fallback path (null projectId) shares a key.
  return runExclusive(args.projectId ?? '__org__', () => reconcileProjectFlowInner(args));
}

async function reconcileProjectFlowInner(args: ReconcileProjectArgs): Promise<ReconcileOutcome> {
  const { storage, hubConfig, projectId, remoteUrl, lastEtag, fetchImpl, emit } = args;
  const baseUrl = `${hubConfig.url.replace(/\/$/, '')}/v1/flows/active`;
  // Prefer the global repo key; fall back to the legacy projectId key for
  // projects with no git remote / un-migrated callers.
  const url = remoteUrl
    ? `${baseUrl}?repo=${encodeURIComponent(remoteUrl)}`
    : projectId
      ? `${baseUrl}?projectId=${encodeURIComponent(projectId)}`
      : baseUrl;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${hubConfig.token}`,
    Accept: 'application/json',
  };
  if (lastEtag) headers['If-None-Match'] = lastEtag;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: 'GET', headers });
  } catch (e) {
    return { outcome: 'error', etag: lastEtag, error: (e as Error).message };
  }

  if (res.status === 304) {
    return { outcome: 'not-modified', etag: lastEtag };
  }
  if (res.status < 200 || res.status >= 300) {
    return { outcome: 'error', etag: lastEtag, error: `HTTP ${res.status}` };
  }

  const etag = res.headers.get('etag');
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { outcome: 'error', etag: lastEtag, error: 'Invalid JSON from hub' };
  }

  if (!body || body.flow === null || body.flow === undefined) {
    return { outcome: 'no-assignment', etag };
  }

  const remote = body.flow;
  // CGLAB-380: an org-wide flow whose roles or checks do not validate is not
  // installed at all - dropping the bad part would run a flow nobody wrote.
  const contractErrors = flowChecksErrors(remote?.steps ?? []);
  if (contractErrors.length) {
    return { outcome: 'error', etag: lastEtag, error: `Hub flow refused: ${contractErrors.join(' ')}` };
  }
  const hubVersion = typeof body.hubVersion === 'number' ? body.hubVersion : null;

  // Find any existing local row that points at this remote hub flow id.
  const existing = (await storage.listFlows()).find((f) => f.hubFlowId === remote.id);
  const now = new Date();
  const localId = existing?.id ?? randomUUID();

  const upserted: Flow = {
    id: localId,
    name: remote.name,
    description: remote.description ?? '',
    version: existing?.version ?? '1.0.0',
    // Through the SAME whitelist as POST /flows. This path used to take
    // remote.steps verbatim, so an org-wide hub push bypassed normalizeSteps
    // entirely — which meant the flow-step field whitelist did not cover the one
    // channel whose untrustworthiness is the whole reason it exists. Duplicate
    // step ids and empty names got through here too.
    // CGLAB-428: the only path that keeps `disabledChecks` - the org hub may switch a check off.
    steps: normalizeFlowSteps(remote.steps ?? [], () => randomUUID(), { allowDisabledChecks: true }),
    // 281adef0: where the flow runs the suite travels with it, BOTH ways - written
    // every sync, because updateFlow merges and an omitted key would keep 'parent'
    // after the org turned it off. Anything unknown is the default.
    verifyAt: remote.verifyAt === 'parent' ? 'parent' : 'leaf',
    // 7ddeaf7c: and how far 'parent' reaches, written every sync for the same reason.
    verifyAtScope: remote.verifyAtScope === 'project' ? 'project' : 'worktree',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    source: 'hub',
    hubFlowId: remote.id,
    hubVersion: hubVersion ?? undefined,
  };

  if (existing) {
    await storage.updateFlow(localId, upserted);
  } else {
    await storage.createFlow(upserted);
  }

  // Re-bind only this project (when a projectId was supplied). The fleet-wide
  // re-bind we used to do for the org-default flow happens in runFlowSyncTick
  // when a project's effective flow comes back as the org-scope.
  if (projectId) {
    const proj = await storage.getProject(projectId);
    if (proj && proj.flowId !== localId) {
      await storage.updateProject(projectId, { flowId: localId });
    }
  }

  emit('flow:updated', { flowId: localId, projectId: projectId ?? undefined });
  return { outcome: 'updated', etag, localFlowId: localId };
}

// ── Per-tick polling ────────────────────────────────────────────────────────

export interface RunTickArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  fetchImpl: FetchLike;
  emit: (event: string, payload: any) => void;
  /** Per-project ETag cache. Mutated in place. */
  etagCache: Map<string, string>;
  /** Resolve a project's raw git remote URL for the repo-keyed hub query.
   *  Returns null when the project has no remote (falls back to projectId). */
  resolveRepo?: (projectId: string) => Promise<string | null>;
  /** Where the Airlock sync rewrites the adapters' state file (default ~/.agenfk/airlock-state.json). */
  airlockStateFile?: string;
  /** The hub this installation is joined to now, so a tick that outlived a repoint writes nothing. */
  activeHubConfig?: () => Pick<HubConfig, 'url' | 'orgId'> | null;
  /** Tells the hub which Airlock policy revision this installation applies (HUB-2). */
  reportAirlock?: AirlockApplyReporter;
}

/** The org's Airlock policy; contained, so it never costs another channel anything. */
async function syncAirlockForTick(args: RunTickArgs, generation: number): Promise<void> {
  try {
    await runAirlockSync({
      storage: args.storage,
      hubConfig: args.hubConfig,
      fetchImpl: args.fetchImpl,
      stateFile: args.airlockStateFile,
      emit: args.emit,
      generation,
      activeHubConfig: args.activeHubConfig,
      report: args.reportAirlock,
    });
  } catch (e) {
    console.error('[HUB_AIRLOCK] Unexpected error:', (e as Error).message);
  }
}

/** Every local project's flow, then its repo settings when it has a git remote. */
async function syncProjectsForTick(args: RunTickArgs): Promise<void> {
  const projects = await args.storage.listProjects();
  for (const project of projects) {
    const lastEtag = args.etagCache.get(project.id) ?? null;
    let remoteUrl: string | null = null;
    if (args.resolveRepo) {
      try { remoteUrl = await args.resolveRepo(project.id); } catch { remoteUrl = null; }
    }
    let result: ReconcileOutcome;
    try {
      result = await reconcileProjectFlow({
        storage: args.storage,
        hubConfig: args.hubConfig,
        projectId: project.id,
        remoteUrl,
        lastEtag,
        fetchImpl: args.fetchImpl,
        emit: args.emit,
      });
    } catch (e) {
      // Belt-and-suspenders: any unexpected throw is contained per project.
      console.error(`[HUB_FLOW_SYNC] Unexpected error for project ${project.id}:`, (e as Error).message);
      continue;
    }
    if (result.etag) args.etagCache.set(project.id, result.etag);

    // RFC-002: the hub's authoritative repository settings, after the flow
    // reconcile so a hub outage on one channel never blocks the other. Only a
    // project with a git remote can be keyed on the hub, and its settings ride
    // their own ETag cache key so a 304 on the flow does not skip them.
    if (remoteUrl) {
      try {
        const repoResult = await syncRepoSettings({
          storage: args.storage,
          hubConfig: args.hubConfig,
          projectId: project.id,
          remoteUrl,
          localCommand: declaredVerifyCommand((project as any).projectRoot) ?? (typeof (project as any).verifyCommand === 'string' && (project as any).verifyCommand ? (project as any).verifyCommand : null),
          projectRoot: (project as any).projectRoot ?? null,
          lastEtag: args.etagCache.get('repo:' + project.id) ?? null,
          fetchImpl: args.fetchImpl,
        });
        if (repoResult.etag) args.etagCache.set('repo:' + project.id, repoResult.etag);
      } catch (e) {
        // Contained per project, exactly like the flow reconcile above.
        console.error(`[HUB_REPO_SETTINGS] Unexpected error for project ${project.id}:`, (e as Error).message);
      }
    }
  }
}

/**
 * RFC-002: receipts a card is still holding go to the hub. Publishing is per
 * CARD, not per project, so it has nothing to do with the flow reconcile.
 */
async function publishReceiptsForTick(args: RunTickArgs): Promise<void> {
  try {
    await publishPendingReceipts({
      storage: args.storage,
      hubConfig: args.hubConfig,
      fetchImpl: args.fetchImpl,
    });
  } catch (e) {
    console.error('[HUB_RECEIPTS] publish failed:', (e as Error).message);
  }
}

/**
 * GH-346: the reconciler's three channels, for the hub loop (hubSync.ts) to run
 * side by side. Separate, so the org's Airlock policy never waits behind every
 * project's requests, and a hub outage on one channel never costs another.
 */
export function flowSyncChannels(args: RunTickArgs): HubSyncChannel[] {
  return [
    { name: 'flows', run: () => syncProjectsForTick(args) },
    // The configuration this sync belongs to, taken as it starts: a sync that
    // outlives a repoint or a logout must not sync Airlock with the old credential.
    { name: 'airlock', run: () => syncAirlockForTick(args, currentAirlockGeneration()) },
    { name: 'receipts', run: () => publishReceiptsForTick(args) },
  ];
}

/** Every channel once, side by side, settled when all of them are. */
export async function runFlowSyncTick(args: RunTickArgs): Promise<void> {
  await Promise.allSettled(flowSyncChannels(args).map(c => c.run()));
}
