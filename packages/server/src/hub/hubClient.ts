import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HubEvent } from '@agenfk/core';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, RecordEventInput } from './types.js';
import { resolveActor } from './identity.js';

// Resolved at CALL time (item 9c297075): a module-level os.homedir() capture
// froze the machine home at import time, so per-test HOME sandboxes never
// applied under the Stryker runner (the 2026-08-31 hub.json clobber hole).
export function hubConfigPath(): string {
  return path.join(os.homedir(), '.agenfk', 'hub.json');
}

function readHubConfigFile(): HubConfig | null {
  try {
    const raw = fs.readFileSync(hubConfigPath(), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.url === 'string' && typeof cfg.token === 'string' && typeof cfg.orgId === 'string') {
      return { url: cfg.url, token: cfg.token, orgId: cfg.orgId };
    }
  } catch {
    /* not configured */
  }
  return null;
}

export function loadHubConfig(): HubConfig | null {
  const fileCfg = readHubConfigFile();
  const url = process.env.AGENFK_HUB_URL || fileCfg?.url;
  const token = process.env.AGENFK_HUB_TOKEN || fileCfg?.token;
  const orgId = process.env.AGENFK_HUB_ORG || fileCfg?.orgId;
  if (!url || !token || !orgId) return null;
  return { url, token, orgId };
}

export class HubClient {
  private storage: SQLiteStorageProvider | null = null;
  private config: HubConfig | null;
  private installationId: string;

  constructor(installationId: string, config: HubConfig | null = loadHubConfig()) {
    this.installationId = installationId;
    this.config = config;
  }

  attachStorage(storage: SQLiteStorageProvider): void {
    this.storage = storage;
  }

  get isEnabled(): boolean {
    return this.config !== null;
  }

  get hubConfig(): HubConfig | null {
    return this.config;
  }

  /**
   * Re-read the hub config and adopt it. Returns whether anything changed.
   *
   * Needed because the credential is baked in at construction: the Flusher's
   * axios instance carries the Authorization header it was built with, so after
   * `agenfk hub login` issues a replacement token the running server would keep
   * presenting the revoked one — and its recovery probe would keep failing —
   * until someone restarted it, stranding a perfectly deliverable outbox.
   *
   * The caller is responsible for restarting the subsystems that captured the
   * old config (see startHubSubsystems in server.ts); this only updates what
   * HubClient itself stamps onto events.
   */
  reloadConfig(loader: () => HubConfig | null = loadHubConfig): boolean {
    const next = loader();
    const before = this.config;
    const same = before?.url === next?.url
      && before?.token === next?.token
      && before?.orgId === next?.orgId;
    if (same) return false;
    this.config = next;
    return true;
  }

  /**
   * Append an event to the local outbox. Synchronous and best-effort: never
   * throws on the request path. The flusher will deliver it later.
   *
   * Works WITHOUT a hub config too (CGLAB-11): events raised before
   * `agenfk hub login` are queued with the pending-org sentinel ('') and
   * stamped with the real orgId at boot once a config exists
   * (hubOutboxRewriteOrgId). While unconfigured, the outbox is capped
   * (AGENFK_HUB_OUTBOX_CAP, default 10000, oldest pruned) so a
   * never-connected install can't grow the DB without bound.
   */
  recordEvent(input: RecordEventInput): void {
    if (!this.storage) return;
    try {
      const actor = resolveActor(input.cwd);
      const event: HubEvent = {
        eventId: randomUUID(),
        installationId: this.installationId,
        orgId: this.config?.orgId ?? PENDING_ORG,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        actor,
        projectId: input.projectId,
        remoteUrl: (input as any).remoteUrl ?? null,
        itemId: input.itemId,
        itemType: (input as any).itemType,
        itemTitle: (input as any).itemTitle ?? undefined,
        externalId: (input as any).externalId ?? undefined,
        type: input.type,
        payload: input.payload ?? {},
      };
      this.storage.hubOutboxAppend(event.eventId, event.occurredAt, JSON.stringify(event));
      if (!this.config) this.enforceOutboxCap();
    } catch (e) {
      // Never let hub event recording crash request handling.
      console.error('[HUB] recordEvent failed:', (e as Error).message);
    }
  }

  /** While unconfigured, keep at most AGENFK_HUB_OUTBOX_CAP rows (oldest pruned).
   *  Only PENDING rows (orgId sentinel) are eligible — after a logout, stamped
   *  real-org events awaiting delivery must never be pruned by the cap. */
  private enforceOutboxCap(): void {
    if (!this.storage) return;
    const capRaw = Number(process.env.AGENFK_HUB_OUTBOX_CAP);
    const cap = Number.isFinite(capRaw) && capRaw >= 1 ? Math.floor(capRaw) : 10000;
    const overflow = this.storage.hubOutboxCount() - cap;
    if (overflow <= 0) return;
    // hubOutboxPeek returns oldest-first; scan a bounded window and prune only
    // pending-org rows. If old rows belong to a real org (post-logout), the cap
    // degrades to soft rather than deleting deliverable history.
    const window = this.storage.hubOutboxPeek(Math.min(overflow * 2 + 10, 2000));
    const pruneIds: string[] = [];
    for (const row of window) {
      if (pruneIds.length >= overflow) break;
      try {
        if (JSON.parse(row.payload).orgId === PENDING_ORG) pruneIds.push(row.event_id);
      } catch {
        pruneIds.push(row.event_id); // unparseable rows can never deliver
      }
    }
    this.storage.hubOutboxDelete(pruneIds);
  }
}

/** orgId sentinel for events queued before `agenfk hub login`. */
export const PENDING_ORG = '';
