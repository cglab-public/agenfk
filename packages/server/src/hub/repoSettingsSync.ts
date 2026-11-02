/**
 * Hub repository-settings sync (RFC-002) — pulls the hub's authoritative
 * settings for one project's git remote and stores them on the project as
 * `hubRepoSettings`.
 *
 * The hub is keyed on the raw remote URL, not on the local project id: several
 * machines cloning the same repository adopt the same settings. On first
 * contact, when the hub has no record of the repository yet, the project claims
 * it by POSTing the command this repository declares (or has stored); the hub
 * decides the winner and what it returns is what we store — which may be
 * another producer's claim.
 *
 * A hub that is down, slow or wrong NEVER erases what is already stored: every
 * failure path is an `error` outcome that writes nothing, and a failed GET is
 * never followed by an init.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { normalizeCommandPaths } from '@agenfk/core';
import type { HubConfig } from './types.js';
import type { FetchLike } from './flowSync.js';

export interface HubRepoSettings {
  /** Raw git remote URL the hub keys the record on. */
  remoteUrl: string;
  /** The command the hub says the final verify runs. */
  verifyCommand: string;
  /** Hub-side revision, quoted in refusals so a human can find the record. */
  revision: number;
  receiptsMode: 'off' | 'shadow' | 'enforce';
  shadowThreshold: number | null;
  /**
   * Who may produce the repository's receipts (RFC-002 Amendment 1): the
   * explicit `producers` list, or every live installation of the org. An older
   * hub sends no mode, which means the list.
   */
  producerMode: 'listed' | 'all';
  /** The explicit allowlist. It decides only under `listed`; the hub keeps it under `all`. */
  producers: string[];
  syncedAt: string;
}

export type RepoSyncOutcome =
  | { outcome: 'adopted' | 'initialized'; etag: string | null; settings: HubRepoSettings }
  | { outcome: 'not-modified'; etag: string | null }
  | { outcome: 'none'; etag: null }
  | { outcome: 'error'; etag: string | null; error: string };

export interface SyncRepoSettingsArgs {
  storage: SQLiteStorageProvider;
  hubConfig: HubConfig;
  projectId: string;
  /** Raw git remote URL. Never called for a project without one. */
  remoteUrl: string;
  /** This repository's own command, to claim an unclaimed record with. */
  localCommand: string | null;
  /**
   * This checkout's root, when the caller can see it. The hub keys the record on
   * the remote and runs the command from the repository root on every machine,
   * so a path inside THIS checkout is sent as `./scripts/verify.sh` and a path
   * outside it is refused before the POST — the hub cannot tell the two apart
   * and must never be told about a directory that exists on one laptop.
   */
  projectRoot?: string | null;
  lastEtag: string | null;
  fetchImpl: FetchLike;
}

/**
 * The command this repository declares in `.agenfk/project.json`, or null.
 *
 * Deliberately NOT the server's `readDeclaredSettings`: the hub folder must not
 * depend on server.ts, and the sync only needs the one string, read tolerantly
 * — a project whose settings file is broken simply has no local command to
 * claim with, exactly as the server treats it.
 */
export function declaredVerifyCommand(projectRoot?: string | null): string | null {
  if (!projectRoot) return null;
  try {
    const file = path.join(projectRoot, '.agenfk', 'project.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const value = parsed && typeof parsed === 'object' ? (parsed as any).verifyCommand : undefined;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** A body from the hub becomes settings only if every required field is there. */
function parseSettings(raw: any): HubRepoSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.remoteUrl !== 'string' || !raw.remoteUrl) return null;
  if (typeof raw.verifyCommand !== 'string' || !raw.verifyCommand) return null;
  const receipts = raw.receiptsMode;
  return {
    remoteUrl: raw.remoteUrl,
    verifyCommand: raw.verifyCommand,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    receiptsMode: receipts === 'shadow' || receipts === 'enforce' ? receipts : 'off',
    shadowThreshold: typeof raw.shadowThreshold === 'number' ? raw.shadowThreshold : null,
    producerMode: raw.producerMode === 'all' ? 'all' : 'listed',
    producers: Array.isArray(raw.producers) ? raw.producers.filter((p: unknown): p is string => typeof p === 'string') : [],
    syncedAt: typeof raw.syncedAt === 'string' && raw.syncedAt ? raw.syncedAt : new Date().toISOString(),
  };
}

export async function syncRepoSettings(args: SyncRepoSettingsArgs): Promise<RepoSyncOutcome> {
  const { storage, hubConfig, projectId, remoteUrl, localCommand, lastEtag, fetchImpl } = args;
  const base = hubConfig.url.replace(/\/$/, '');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${hubConfig.token}`,
    Accept: 'application/json',
  };
  if (lastEtag) headers['If-None-Match'] = lastEtag;

  // ── GET the hub's settings for this remote ────────────────────────────────
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${base}/v1/repo-settings?repo=${encodeURIComponent(remoteUrl)}`, { method: 'GET', headers });
  } catch (e) {
    return { outcome: 'error', etag: lastEtag, error: (e as Error).message };
  }
  if (res.status === 304) return { outcome: 'not-modified', etag: lastEtag };
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

  const adopt = async (rawSettings: any): Promise<RepoSyncOutcome> => {
    const settings = parseSettings(rawSettings);
    if (!settings) return { outcome: 'error', etag: lastEtag, error: 'Hub returned malformed repo settings' };
    await storage.updateProject(projectId, { hubRepoSettings: settings } as any);
    return { outcome: 'adopted', etag, settings };
  };

  if (body && body.settings !== null && body.settings !== undefined) {
    return adopt(body.settings);
  }

  // ── The hub knows nothing about this repository: claim it ─────────────────
  if (!localCommand) return { outcome: 'none', etag: null };

  // Make the command portable before it leaves: an absolute path inside this
  // checkout becomes repo-relative, and a path that belongs to this machine
  // alone is refused here rather than claimed on the hub for every clone.
  const portable = normalizeCommandPaths(localCommand, args.projectRoot ?? null);
  if (!portable.ok) return { outcome: 'error', etag, error: portable.reason };

  let initRes: Awaited<ReturnType<FetchLike>>;
  try {
    initRes = await fetchImpl(`${base}/v1/repo-settings/init`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: remoteUrl, verifyCommand: portable.command }),
    });
  } catch (e) {
    return { outcome: 'error', etag, error: (e as Error).message };
  }
  if (initRes.status < 200 || initRes.status >= 300) {
    return { outcome: 'error', etag, error: `HTTP ${initRes.status}` };
  }
  let initBody: any;
  try {
    initBody = await initRes.json();
  } catch {
    return { outcome: 'error', etag, error: 'Invalid JSON from hub' };
  }
  const settings = parseSettings(initBody?.settings);
  if (!settings) return { outcome: 'error', etag, error: 'Hub returned no settings for the claim' };
  await storage.updateProject(projectId, { hubRepoSettings: settings } as any);
  return { outcome: 'initialized', etag, settings };
}
