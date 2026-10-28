import {
  AgEnFKItem,
  ItemType,
  Status,
  Project,
  PauseSnapshot,
  Flow,
  FlowRevision,
  TokenEvent,
  TokenEventQuery,
  IngestionState,
  AppSettings,
  TerminalSession,
  Pr,
  PrSizing,
  AgentRun,
  RunEvent,
  AgentRunQuery,
} from './types';
import type { AirlockMode, StoredAirlockPolicy } from './airlock/types';
import type { AirlockHostObservation, AirlockLearnedHost } from './airlock/learnTypes';
import type { AirlockAlert } from './airlock/types';

export interface PluginConfig {
  [key: string]: any;
}

export interface AgEnFKPlugin {
  name: string;
  version: string;
  init(config: PluginConfig): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface StorageQuery {
  projectId?: string;
  type?: ItemType;
  status?: Status;
  parentId?: string;
  limit?: number;
  offset?: number;
  /**
   * e248239d: false leaves each capture record's per-test results as a
   * `testsBlob` reference instead of reading them back - for a caller that
   * never reads them (the item list). Default true.
   */
  hydrate?: boolean;
}

export interface StorageProvider extends AgEnFKPlugin {
  // Projects
  createProject(project: Project): Promise<Project>;
  updateProject(id: string, updates: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<boolean>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // Items
  createItem(item: AgEnFKItem): Promise<AgEnFKItem>;
  updateItem(id: string, updates: Partial<AgEnFKItem>): Promise<AgEnFKItem>;
  deleteItem(id: string): Promise<boolean>;
  getItem(id: string): Promise<AgEnFKItem | null>;
  /**
   * 80920048: one stored value by its hash - a capture record's file map
   * (`fileShasBlob`), which reads leave as a reference. Null when it is not
   * there. Optional: a provider without it gives no partial runs from a map.
   */
  readBlob?(hash: string): Promise<unknown | null>;
  /**
   * ec325925: replace a card's step records as housekeeping - no updatedAt,
   * no history - and drop the results blobs nothing references any more.
   * Optional: a provider without them is simply not pruned.
   */
  rewriteRecords?(id: string, records: { stepRecords?: unknown[]; supersededRecords?: unknown[] }): Promise<void>;
  sweepUnreferencedBlobs?(): Promise<number>;
  listItems(query?: StorageQuery): Promise<AgEnFKItem[]>;
  listChildren(parentId: string): Promise<AgEnFKItem[]>;

  // Snapshots (pause/resume)
  createSnapshot(snapshot: PauseSnapshot): Promise<PauseSnapshot>;
  getSnapshot(id: string): Promise<PauseSnapshot | null>;
  getSnapshotByItemId(itemId: string): Promise<PauseSnapshot | null>;
  deleteSnapshot(id: string): Promise<boolean>;

  // Flows
  createFlow(flow: Flow): Promise<Flow>;
  updateFlow(id: string, updates: Partial<Flow>): Promise<Flow>;
  deleteFlow(id: string): Promise<boolean>;
  getFlow(id: string): Promise<Flow | null>;
  listFlows(): Promise<Flow[]>;
  /** CGLAB-607: all immutable revisions of a flow, oldest first. */
  listFlowRevisions(id: string): Promise<FlowRevision[]>;

  // Observability — token events (server-side ingestion of per-client session logs)
  insertTokenEvent(event: TokenEvent): Promise<void>;
  queryTokenEvents(query: TokenEventQuery): Promise<TokenEvent[]>;
  listTerminalSessions(projectId?: string): Promise<TerminalSession[]>;
  recordTerminalSession(session: TerminalSession): Promise<TerminalSession>;
  forgetTerminalSession(id: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  /** Merges: keys left out keep their stored value rather than being blanked. */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getIngestionState(sourcePath: string): Promise<IngestionState | null>;
  setIngestionState(state: IngestionState): Promise<void>;

  // Observability — agent runs (orchestrated worker transcripts per item)
  createAgentRun(run: AgentRun): Promise<AgentRun>;
  updateAgentRun(id: string, updates: Partial<AgentRun>): Promise<AgentRun>;
  getAgentRun(id: string): Promise<AgentRun | null>;
  listAgentRuns(query: AgentRunQuery): Promise<AgentRun[]>;
  getAgentRunBySession(sessionId: string): Promise<AgentRun | null>;
  /**
   * Append an event, answering with the position it was given.
   *
   * The position may be assigned by the store when the caller omits it, and
   * the caller needs it back: the object it handed over still says undefined,
   * and anything that broadcasts that object leaves every consumer unable to
   * order or de-duplicate. Null means nothing was written.
   */
  appendRunEvent(event: RunEvent): Promise<number | null>;
  listRunEvents(runId: string): Promise<RunEvent[]>;

  // Observability — PR sizing (agent-declared)
  insertPr(pr: Pr): Promise<Pr>;
  updatePrSizing(repo: string, prNumber: number, sizing: PrSizing, shadow?: PrSizing): Promise<Pr>;
  getPrByRepoNumber(repo: string, prNumber: number): Promise<Pr | null>;
  getPrsByItemId(itemId: string): Promise<Pr[]>;

  // Airlock (GH-294). The policy is one JSON row per scope, written by
  // compare-and-swap on its revision; never in app_settings.
  getAirlockPolicy(scope: AirlockScope): Promise<StoredAirlockPolicy | null>;
  /**
   * Store `row` (at `row.revision`) when the stored revision of its scope is
   * `expectedRevision` (0 when there is none). Otherwise nothing is written and
   * it rejects with an AirlockStaleRevisionError.
   */
  putAirlockPolicy(row: StoredAirlockPolicy, expectedRevision: number): Promise<StoredAirlockPolicy>;
  /** Remove a scope's row (leaving the hub drops the hub row once it is copied to local). True when one was removed. */
  deleteAirlockPolicy(scope: AirlockScope): Promise<boolean>;
  /**
   * Leaving the hub, in one transaction: the hub row (only if it is at
   * `expectedHubRevision`) becomes the local row at the next local revision and
   * the hub row is deleted. Null, with nothing changed, when there is no such hub row.
   */
  releaseAirlockHubPolicy(expectedHubRevision: number, meta: { updatedAt: string; updatedBy: string }): Promise<StoredAirlockPolicy | null>;
  /** Appends to the decision log, trimming the oldest past its cap. */
  recordAirlockDecision(decision: AirlockDecisionRecord): Promise<void>;
  /** Newest first. */
  listAirlockDecisions(query?: AirlockDecisionQuery): Promise<AirlockDecisionRecord[]>;
  /** `now` (ISO) judges whether a held grant is spent; it defaults to the wall clock. */
  upsertAirlockApproval(request: AirlockApprovalRequest, now?: string): Promise<AirlockApprovalRecord>;
  getAirlockApproval(key: string): Promise<AirlockApprovalRecord | null>;
  listAirlockApprovals(query?: { pending?: boolean }): Promise<AirlockApprovalRecord[]>;
  /**
   * Grant a pending (or denied) request. With `generation`, only that
   * generation: a stale or replayed answer is refused and changes nothing. A
   * grant already held is left as it is (no renewed expiry); a used one is
   * never brought back. Null when no request has that key.
   */
  grantAirlockApproval(key: string, grant: { grantedBy: string; authority: string; expiresAt?: string | null; generation?: number }): Promise<AirlockApprovalTransition | null>;
  /** True once, for a granted, unexpired, unconsumed request; false otherwise. `now` defaults to the wall clock. */
  consumeAirlockApproval(key: string, now?: string): Promise<boolean>;
  /**
   * Consume every grant in `keys`, all in one transaction, only where each is
   * granted, unused, unexpired and asked for by `scope`; if any one is not,
   * none is consumed and the answer is false.
   */
  consumeAirlockApprovals(keys: string[], scope: AirlockGrantScope, now?: string): Promise<boolean>;
  /**
   * A person said no: the request is denied, and any grant not yet used is
   * revoked. It stays denied until someone grants it. Null when no request has that key.
   */
  denyAirlockApproval(key: string, denial: { deniedBy: string; generation?: number }, now?: string): Promise<AirlockApprovalTransition | null>;
  /** Learning mode (TEL-3): merge host sightings into one row per host (mergeHostObservation), in one transaction, capped. */
  recordAirlockHostObservations(observations: AirlockHostObservation[]): Promise<void>;
  /** Every learned host, most recently seen first. */
  listAirlockLearnedHosts(): Promise<AirlockLearnedHost[]>;
  /** SX-1: record cards an Airlock sandbox touched; one already recorded keeps its first `since`. */
  markAirlockCovered(itemIds: string[], since: string): Promise<void>;
  /** Which of `itemIds` are recorded as covered. */
  airlockCoveredAmong(itemIds: string[]): Promise<string[]>;
  /** When a card was first covered; null when it never was. */
  airlockCoveredSince(itemId: string): Promise<string | null>;
}

export type AirlockScope = 'local' | 'hub';

/** Thrown by putAirlockPolicy when the stored revision is not the expected one. */
export interface AirlockStaleRevisionError extends Error {
  code: 'AIRLOCK_STALE_REVISION';
  currentRevision: number;
}

/** One logged Airlock verdict. `target` is redacted before it is stored. */
export interface AirlockDecisionRecord {
  id?: number;
  ts: string;
  client: string;
  model: string | null;
  tool: string;
  capabilityKind: string | null;
  target: string | null;
  /** In observe mode, the decision enforce would have made. */
  decision: 'allow' | 'deny' | 'needs-human-approval';
  rule: string | null;
  mode: AirlockMode;
  itemId?: string | null;
  sessionId?: string | null;
  /** Who made it: a tool call judged by POST /airlock/evaluate, or the sandbox proxy (TEL-1). Absent reads as 'tool'. */
  source?: 'tool' | 'proxy';
  /** TEL-2: the alert this decision is (airlockAlertOf), if any. Absent: no alert. */
  alert?: AirlockAlert;
}

/** Which decisions to read (TEL-2); every filter given must match. `alert: 'any'` is every alert. */
export interface AirlockDecisionQuery {
  limit?: number;
  itemId?: string;
  client?: string;
  source?: 'tool' | 'proxy';
  alert?: AirlockAlert | 'any';
}

/** One capability an approval binds, as a person reads it: redacted before it is stored. */
export interface AirlockApprovalCapability {
  kind: 'command' | 'path' | 'url';
  value: string;
  access?: 'read' | 'write';
  /** false: the value was too long to store whole, so the request cannot be approved. */
  complete?: boolean;
  /** true: redaction replaced a span holding code that runs, so the request cannot be approved. */
  concealed?: boolean;
}

/** Who may spend a grant: the session and card that asked for it. */
export interface AirlockGrantScope {
  sessionId: string | null;
  itemId: string | null;
}

export interface AirlockApprovalRequest {
  key: string;
  rule: string;
  summary: string;
  /** Every capability the key binds (redacted). */
  capabilities?: AirlockApprovalCapability[];
  projectId?: string | null;
  itemId?: string | null;
  sessionId?: string | null;
  requestedAt: string;
}

export interface AirlockApprovalRecord extends AirlockApprovalRequest {
  grantedAt: string | null;
  grantedBy: string | null;
  authority: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  /** Set when a person denied the request; cleared by a grant. */
  deniedAt?: string | null;
  deniedBy?: string | null;
  /** Bumped each time the request (re)opens as pending; an answer names the generation it answers. */
  generation?: number;
}

/** A grant or denial: the row as it now stands, and whether this call changed it. */
export type AirlockApprovalTransition = AirlockApprovalRecord & { transition: 'changed' | 'unchanged' | 'refused' };

export interface TokenTracker extends AgEnFKPlugin {
  trackUsage(itemId: string, input: number, output: number, model: string): Promise<void>;
  getUsage(itemId: string): Promise<any>; // Define stricter type later
}

export interface LLMProvider extends AgEnFKPlugin {
  generate(prompt: string, context?: any): Promise<string>;
}

// ── Corporate Hub event envelope ─────────────────────────────────────────────
// Optional component: when an installation is configured to push to a corp hub
// (~/.agenfk/hub.json present), local mutations emit HubEvents that are buffered
// in a local outbox and flushed to the hub via HTTPS. Pure type definitions —
// no runtime imports — so this remains safe for browser consumers.

/** Event types the hub still accepts but never stores or offers. */
export type LegacyHubEventType = 'tokens.logged';

export type HubEventType =
  | 'item.created'
  | 'item.updated'
  | 'item.moved'
  | 'item.deleted'
  | 'item.closed'
  | 'step.transitioned'
  | 'validate.invoked'
  | 'validate.passed'
  | 'validate.failed'
  // A person's go-ahead for a step, or their pass of a blocked check (CGLAB-382).
  | 'step.approved'
  | 'check.overridden'
  // A passkey enrolled on, or removed from, the board (CGLAB-383).
  | 'passkey.enrolled'
  | 'passkey.removed'
  // A person's approval of a command check's exact argv for a project (efcacdeb).
  | 'command.approved'
  | 'comment.added'
  | 'test.logged'
  // Legacy inbound-only event. Spokes no longer emit this, and Hub skips it
  // during ingest so token consumption is not stored.
  | LegacyHubEventType
  | 'session.started'
  | 'session.ended'
  // Fleet upgrade lifecycle (Story 2/3 of EPIC 541c12b3 — remote upgrade).
  | 'fleet:upgrade:started'
  | 'fleet:upgrade:succeeded'
  | 'fleet:upgrade:failed'
  // Repoint campaign lifecycle (CGLAB-66). `succeeded` is only believed when
  // it arrives on the campaign's target hostname — see routes/events.ts.
  | 'hub:repoint:succeeded'
  | 'hub:repoint:blocked'
  | 'hub:repoint:failed'
  // PR registration events emitted by the spoke on register/update.
  | 'pr.opened'
  | 'pr.updated'
  // Airlock (GH-294): a logged verdict, a local policy write refused because
  // the hub owns the policy, and an accepted policy change.
  | 'airlock.decision'
  | 'airlock.local-write-refused'
  | 'airlock.policy-changed'
  // Which hub policy revision this installation applies, and a hub policy it refused as invalid (HUB-2).
  | 'airlock.policy-applied'
  | 'airlock.policy-refused'
  // A human-approval request: requested, granted or denied on the board, or a grant used.
  | 'airlock.approval'
  // Learning mode (TEL-3): a person's proposed allowlist, host names and counts, for an org admin to accept.
  | 'airlock.learning-proposal'
  /** DS-1: a full tool-call row, and a label joined to one, for the Airlock dataset (sent only while the hub's switch is on). */
  | 'airlock.dataset'
  | 'airlock.dataset-label';

export interface HubActor {
  osUser: string;
  gitName: string | null;
  gitEmail: string | null;
}

export interface HubEvent {
  eventId: string;
  installationId: string;
  orgId: string;
  occurredAt: string; // ISO-8601 UTC
  receivedAt?: string; // set by hub on ingest
  actor: HubActor;
  projectId?: string;
  // Stable cross-installation project identity. Populated from the project's
  // `git remote get-url origin` (or repo equivalent) by the agenfk client.
  // Hub queries use this to group activity by repo across users.
  remoteUrl?: string | null;
  itemId?: string;
  // EPIC | STORY | TASK | BUG (when the event refers to an item).
  itemType?: string;
  // Human-readable title of the item at the time of the event. Persisted as a
  // first-class column on the hub so timelines can render names, not UUIDs.
  itemTitle?: string;
  // Reference into an external tracker (e.g. Jira issue key like "WEB-123").
  externalId?: string;
  // The tracker's browse URL for externalId, as stored on the item.
  externalUrl?: string;
  type: HubEventType;
  payload: Record<string, unknown>;
}
