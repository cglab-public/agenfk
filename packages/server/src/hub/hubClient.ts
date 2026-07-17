import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HubEvent } from '@agenfk/core';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubConfig, RecordEventInput } from './types.js';
import { resolveActor } from './identity.js';

const HUB_CONFIG_PATH = path.join(os.homedir(), '.agenfk', 'hub.json');

function readHubConfigFile(): HubConfig | null {
  try {
    const raw = fs.readFileSync(HUB_CONFIG_PATH, 'utf8');
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

  /** While unconfigured, keep at most AGENFK_HUB_OUTBOX_CAP rows (oldest pruned). */
  private enforceOutboxCap(): void {
    if (!this.storage) return;
    const cap = Number(process.env.AGENFK_HUB_OUTBOX_CAP) > 0 ? Number(process.env.AGENFK_HUB_OUTBOX_CAP) : 10000;
    const overflow = this.storage.hubOutboxCount() - cap;
    if (overflow <= 0) return;
    // hubOutboxPeek returns oldest-first, so the first `overflow` rows are the prune set.
    const oldest = this.storage.hubOutboxPeek(overflow);
    this.storage.hubOutboxDelete(oldest.map(r => r.event_id));
  }
}

/** orgId sentinel for events queued before `agenfk hub login`. */
export const PENDING_ORG = '';

export const HUB_CONFIG_FILE = HUB_CONFIG_PATH;
