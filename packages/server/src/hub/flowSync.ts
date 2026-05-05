/**
 * Hub flow reconciler — pulls the org's currently-assigned flow from the corp
 * Hub and reconciles it into local storage with `source = 'hub'`.
 *
 * Single iteration is `reconcileHubFlow()` (pure, testable). The polling loop
 * is `startFlowSync()`, which schedules iterations with exponential backoff on
 * error and emits `flow:updated` socket events on change.
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

export interface ReconcileArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  /** ETag from the last successful pull. Sent as If-None-Match. */
  lastEtag: string | null;
  fetchImpl: FetchLike;
  /** Fired with ('flow:updated', { flowId }) on successful upsert. */
  emit: (event: string, payload: any) => void;
}

export type ReconcileOutcome =
  | { outcome: 'updated'; etag: string | null; localFlowId: string }
  | { outcome: 'not-modified'; etag: string | null }
  | { outcome: 'no-assignment'; etag: string | null }
  | { outcome: 'error'; etag: string | null; error: string };

export async function reconcileHubFlow(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const { storage, hubConfig, lastEtag, fetchImpl, emit } = args;
  const url = `${hubConfig.url.replace(/\/$/, '')}/v1/flows/active`;
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
  } catch (e) {
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

  // Re-bind every project's flowId to the hub-managed local flow.
  const projects = await storage.listProjects();
  for (const p of projects) {
    if (p.flowId !== localId) {
      await storage.updateProject(p.id, { flowId: localId });
    }
  }

  emit('flow:updated', { flowId: localId });
  return { outcome: 'updated', etag, localFlowId: localId };
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
  let etag: string | null = null;
  let stopped = false;
  let consecutiveErrors = 0;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const result = await reconcileHubFlow({
      storage: args.storage,
      hubConfig: args.hubConfig,
      lastEtag: etag,
      fetchImpl,
      emit: args.emit,
    });
    if (result.etag) etag = result.etag;
    if (result.outcome === 'error') {
      consecutiveErrors = Math.min(consecutiveErrors + 1, 4);
    } else {
      consecutiveErrors = 0;
    }
    const delay = baseInterval * Math.pow(2, consecutiveErrors);
    timer = setTimeout(tick, Math.min(delay, baseInterval * 16));
  };

  // Defer the first tick so server startup never blocks and tests that
  // rapidly tear-down/re-init storage don't race with an in-flight reconcile.
  // 1s is fast enough in production for "soon after boot" semantics, and far
  // longer than any reasonable test lifetime.
  const firstDelay = Number(process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS);
  timer = setTimeout(tick, Number.isFinite(firstDelay) && firstDelay >= 0 ? firstDelay : 1000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
