/**
 * Hub flow reconciler — pulls the org's currently-assigned flow from the corp
 * Hub and reconciles it into local storage with `source = 'hub'`.
 *
 * Two layers:
 *  - `reconcileProjectFlow()` does one round-trip for one (optional) projectId.
 *  - `runFlowSyncTick()` iterates the locally-known projects and calls the
 *    above for each, threading a per-project ETag cache. The polling loop in
 *    `startFlowSync()` schedules these ticks with exponential backoff.
 */
import { randomUUID } from 'crypto';
import type { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { Flow } from '@agenfk/core';
import type { HubConfig } from './types.js';

export type FetchLike = (url: string, opts: any) => Promise<{
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  json: () => Promise<any>;
}>;

export interface ReconcileProjectArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  /** Project to fetch the effective flow for. Pass null/undefined for org-fallback. */
  projectId: string | null;
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

export async function reconcileProjectFlow(args: ReconcileProjectArgs): Promise<ReconcileOutcome> {
  const { storage, hubConfig, projectId, lastEtag, fetchImpl, emit } = args;
  const baseUrl = `${hubConfig.url.replace(/\/$/, '')}/v1/flows/active`;
  const url = projectId ? `${baseUrl}?projectId=${encodeURIComponent(projectId)}` : baseUrl;
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
    steps: remote.steps ?? [],
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

// ── Backwards-compat single-shot reconciler ─────────────────────────────────
// Kept as a thin wrapper for callers that don't yet thread project context.

export interface ReconcileArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  lastEtag: string | null;
  fetchImpl: FetchLike;
  emit: (event: string, payload: any) => void;
}

export async function reconcileHubFlow(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const result = await reconcileProjectFlow({
    storage: args.storage,
    hubConfig: args.hubConfig,
    projectId: null,
    lastEtag: args.lastEtag,
    fetchImpl: args.fetchImpl,
    emit: args.emit,
  });
  // Org-scope path retains the old behaviour of re-binding every project to the
  // org-default flow — the per-project loop is the new normal but this keeps
  // the (test-only) single-shot path working.
  if (result.outcome === 'updated') {
    const projects = await args.storage.listProjects();
    for (const p of projects) {
      if (p.flowId !== result.localFlowId) {
        await args.storage.updateProject(p.id, { flowId: result.localFlowId });
      }
    }
  }
  return result;
}

// ── Per-tick polling ────────────────────────────────────────────────────────

export interface RunTickArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  fetchImpl: FetchLike;
  emit: (event: string, payload: any) => void;
  /** Per-project ETag cache. Mutated in place. */
  etagCache: Map<string, string>;
}

export async function runFlowSyncTick(args: RunTickArgs): Promise<void> {
  const projects = await args.storage.listProjects();
  if (projects.length === 0) return;

  for (const project of projects) {
    const lastEtag = args.etagCache.get(project.id) ?? null;
    let result: ReconcileOutcome;
    try {
      result = await reconcileProjectFlow({
        storage: args.storage,
        hubConfig: args.hubConfig,
        projectId: project.id,
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
  }
}

// ── Polling loop ───────────────────────────────────────────────────────────

export interface FlowSyncHandle {
  stop: () => void;
}

export interface StartFlowSyncArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  intervalMs?: number;
  fetchImpl?: FetchLike;
  emit: (event: string, payload: any) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function startFlowSync(args: StartFlowSyncArgs): FlowSyncHandle {
  const baseInterval = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const etagCache = new Map<string, string>();
  let stopped = false;
  let consecutiveErrors = 0;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runFlowSyncTick({
        storage: args.storage,
        hubConfig: args.hubConfig,
        fetchImpl,
        emit: args.emit,
        etagCache,
      });
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors = Math.min(consecutiveErrors + 1, 4);
      console.error('[HUB_FLOW_SYNC] tick failed:', (e as Error).message);
    }
    const delay = baseInterval * Math.pow(2, consecutiveErrors);
    timer = setTimeout(tick, Math.min(delay, baseInterval * 16));
  };

  // Defer the first tick so server startup never blocks and tests that
  // rapidly tear-down/re-init storage don't race with an in-flight reconcile.
  // 1s in production for "soon after boot" semantics; configurable via env.
  const firstDelay = Number(process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS);
  timer = setTimeout(tick, Number.isFinite(firstDelay) && firstDelay >= 0 ? firstDelay : 1000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
