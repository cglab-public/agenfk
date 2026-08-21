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
}

export type RecordEventInput = Omit<HubEvent, 'eventId' | 'installationId' | 'orgId' | 'occurredAt' | 'actor'> & {
  type: HubEventType;
  cwd?: string;
  occurredAt?: string;
};
