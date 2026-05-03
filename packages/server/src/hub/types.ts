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
}

export type RecordEventInput = Omit<HubEvent, 'eventId' | 'installationId' | 'orgId' | 'occurredAt' | 'actor'> & {
  type: HubEventType;
  cwd?: string;
  occurredAt?: string;
};
