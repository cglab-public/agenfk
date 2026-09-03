import { HubEvent, HubEventType } from '@agenfk/core';

export interface HubConfig {
  url: string;
  token: string;
  orgId: string;
}

export interface FlusherStatus {
  enabled: boolean;
  lastFlushAt: string | null;
  lastError: string | null;
  outboxDepth: number;
  halted: boolean;
  /** Consecutive failed delivery attempts; reset by any successful flush. */
  consecutiveFailures: number;
  /** When the next attempt becomes eligible, if currently backing off. */
  nextRetryAt?: string | null;
  /**
   * Events the hub accepted the request for but refused to store, cumulative.
   * Deleting them is right — the hub will refuse a retry identically — but a
   * silent count of zero is how a systematic rejection destroyed data unnoticed.
   */
  rejectedByHub: number;
  /** When the hub last refused events, if ever. */
  lastRejectionAt?: string | null;
  /**
   * Outbox rows whose embedded orgId differs from the config org (CGLAB-117).
   * They are never delivered under current credentials — the 31 Aug incident
   * shipped such rows, lost them to a 2xx-with-rejections, and deleted them.
   * They wait in the outbox for `agenfk hub carry-over` or discard. The
   * PENDING_ORG sentinel is excluded (awaiting-stamp is a different condition).
   */
  staleOrgDepth: number;
  /** Line count of the deadletter file (~/.agenfk/hub-deadletter.jsonl), 0 when absent. */
  deadletterDepth: number;
}

export type RecordEventInput = Omit<HubEvent, 'eventId' | 'installationId' | 'orgId' | 'occurredAt' | 'actor'> & {
  type: HubEventType;
  cwd?: string;
  occurredAt?: string;
};
