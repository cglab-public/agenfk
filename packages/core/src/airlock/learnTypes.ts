/**
 * Airlock learning mode's types (GH-294, TEL-3), apart from learn.ts so the
 * storage interface can name them without pulling node builtins into the
 * browser builds that type-check core.
 */
export type AirlockLearnSource = 'tool' | 'proxy' | 'import';

/** One sighting of a host (an import carries its count and window). */
export interface AirlockHostObservation {
  host: string;
  source: AirlockLearnSource;
  client: string;
  itemId?: string | null;
  /** When it was seen: for an import, the last time. ISO. */
  ts: string;
  /** An import's count; 1 otherwise. */
  hits?: number;
  /** An import's first sighting. ISO. */
  firstSeen?: string | null;
  /** When the server received it, by its own clock (defaults to now). ISO. */
  receivedAt?: string;
}

/** Everything learned about one host. */
export interface AirlockLearnedHost {
  host: string;
  hits: Record<AirlockLearnSource, number>;
  firstSeen: string;
  lastSeen: string;
  /** The server's receipt time of the latest sighting: what retention goes by. */
  receivedAt: string;
  clients: string[];
  cards: string[];
}

export type AirlockLearningExclusion =
  | 'metadata-endpoint'
  | 'ioc-host'
  | 'denied-host'
  | 'already-allowed'
  | 'private-address';

export type AirlockLearningEvidence = 'proxy' | 'agent-reported';

export interface AirlockProposedHost {
  host: string;
  /** All sources together. */
  hits: number;
  sources: Record<AirlockLearnSource, number>;
  evidence: AirlockLearningEvidence;
  firstSeen: string;
  lastSeen: string;
  clients: string[];
  cards: string[];
}

export interface AirlockProposal {
  hosts: AirlockProposedHost[];
  excluded: Array<{ host: string; reason: AirlockLearningExclusion }>;
}

/** A pi session-log import's tally of one host. */
export interface AirlockImportTally {
  hits: number;
  firstSeen: string | null;
  lastSeen: string | null;
}
