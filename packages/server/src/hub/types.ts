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
}

export type RecordEventInput = Omit<HubEvent, 'eventId' | 'installationId' | 'orgId' | 'occurredAt' | 'actor'> & {
  type: HubEventType;
  cwd?: string;
  occurredAt?: string;
};
