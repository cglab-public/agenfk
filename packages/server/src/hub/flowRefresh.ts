/**
 * On-demand hub flow refresh.
 *
 * The 5-minute poll (`startFlowSync`) keeps the local server eventually
 * consistent with the corp Hub's flow assignments, but a user who just pressed
 * "Use this flow" in the Hub expects `agenfk flow show` to reflect it now. This
 * helper performs a single ETag-aware reconcile for one project on demand,
 * sharing the poller's ETag cache so a fresh pull and the poll never double
 * work. Any failure is swallowed: the caller then reads whatever local flow it
 * already had, so a down/slow/unauthorized Hub degrades to the last-known flow
 * rather than an error.
 */
import { reconcileProjectFlow, type FetchLike, type ReconcileOutcome } from './flowSync.js';
import type { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { HubConfig } from './types.js';

export interface RefreshProjectFlowArgs {
  storage: SQLiteStorageProvider;
  /** Whether the corp Hub is configured/enabled for this server. */
  hubEnabled: boolean;
  hubConfig: HubConfig | null | undefined;
  projectId: string;
  /** Raw git remote URL for the project; when present the hub is queried by repo. */
  remoteUrl?: string | null;
  fetchImpl: FetchLike;
  emit: (event: string, payload: any) => void;
  /** Shared with the polling reconciler so ETags aren't fetched twice. */
  etagCache: Map<string, string>;
}

/**
 * Attempt to pull this project's currently-assigned Hub flow into local storage.
 * Never throws — on any error it returns having left local state untouched, so
 * the caller falls back to the local flow.
 */
export async function refreshProjectFlowFromHub(args: RefreshProjectFlowArgs): Promise<ReconcileOutcome | null> {
  if (!args.hubEnabled || !args.hubConfig) return null;
  try {
    const lastEtag = args.etagCache.get(args.projectId) ?? null;
    const result = await reconcileProjectFlow({
      storage: args.storage,
      hubConfig: args.hubConfig,
      projectId: args.projectId,
      remoteUrl: args.remoteUrl ?? null,
      lastEtag,
      fetchImpl: args.fetchImpl,
      emit: args.emit,
    });
    if (result.etag) args.etagCache.set(args.projectId, result.etag);
    return result;
  } catch (e) {
    // reconcileProjectFlow already contains transport/HTTP errors as an 'error'
    // outcome; this guards any unexpected storage throw. Either way: fall back.
    console.error(
      `[HUB_FLOW_SYNC] on-demand refresh failed for project ${args.projectId}:`,
      (e as Error).message,
    );
    return null;
  }
}
