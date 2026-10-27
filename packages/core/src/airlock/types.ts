/**
 * Airlock: a per-tool-call policy that stops an agent reaching cloud metadata,
 * known-bad hosts, or uploading/exfiltrating to hosts nobody listed.
 *
 * Everything under `airlock/` imports node builtins only (a test pins it), so the
 * layer-2 egress proxy can load the same engine the server does.
 */

export type AirlockMode = 'off' | 'observe' | 'enforce';
export type AirlockClient = 'pi' | 'opencode';
/** 'api.x.com' | '*.x.com' | '*' | '10.0.0.0/8' | 'fd00::/8' | '169.254.169.254' */
export type HostPattern = string;

/** Case-insensitive globs (`*`, `?`); an omitted field means `*`. */
export interface ModelSelector {
  client?: AirlockClient | '*';
  provider?: string;
  model?: string;
}

export type RuleAction = 'deny' | 'needs-human-approval' | 'off';

export interface AirlockRules {
  uploadToUnlistedHost: RuleAction;
  credentialReadWithNetwork: RuleAction;
  /** unshare / nsenter in command position */
  namespaceEscape: RuleAction;
  /** mutating verbs of aws / gcloud / az / kubectl / terraform / pulumi */
  cloudMutation: RuleAction;
}

export interface AirlockPolicy {
  schemaVersion: 1;
  mode: AirlockMode;
  /** [] = every session */
  models: ModelSelector[];
  appliesWhenModelUnknown: boolean;
  hosts: { allow: HostPattern[]; deny: HostPattern[] };
  iocHosts: { revision: string; hosts: HostPattern[]; updatedAt: string | null };
  rules: AirlockRules;
}

/** Cloud metadata endpoints. Always denied; no policy can allow-list them. */
export const BUILTIN_DENY_HOSTS = Object.freeze([
  '169.254.169.254',
  'metadata.google.internal',
  'fd00:ec2::254',
  '100.100.100.200',
] as const);

export const DEFAULT_AIRLOCK_RULES: Readonly<AirlockRules> = Object.freeze({
  uploadToUnlistedHost: 'deny',
  credentialReadWithNetwork: 'deny',
  namespaceEscape: 'deny',
  cloudMutation: 'needs-human-approval',
});

/** Off until someone turns it on. Frozen: copy it (normalizeAirlockPolicy) before changing. */
export const DEFAULT_AIRLOCK_POLICY: Readonly<AirlockPolicy> = Object.freeze({
  schemaVersion: 1,
  mode: 'off',
  models: Object.freeze([]) as unknown as ModelSelector[],
  appliesWhenModelUnknown: true,
  hosts: Object.freeze({
    allow: Object.freeze([]) as unknown as HostPattern[],
    deny: Object.freeze([]) as unknown as HostPattern[],
  }),
  iocHosts: Object.freeze({ revision: '', hosts: Object.freeze([]) as unknown as HostPattern[], updatedAt: null }),
  rules: DEFAULT_AIRLOCK_RULES as AirlockRules,
}) as Readonly<AirlockPolicy>;

export type AirlockRuleId =
  | 'builtin-metadata-deny'
  | 'ioc-host'
  | 'denied-host'
  | 'upload-to-unlisted-host'
  | 'credential-read-with-network'
  | 'namespace-escape'
  | 'cloud-mutation';

export type Capability =
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string; access: 'read' | 'write' }
  | { kind: 'url'; url: string };

export interface SessionModel {
  provider: string | null;
  id: string | null;
}

export interface CardContext {
  itemId?: string;
  projectId?: string;
  step?: string;
  /** approval keys granted and not yet consumed */
  grants?: string[];
}

export interface AirlockInput {
  client: AirlockClient;
  model: SessionModel;
  /** Recorded for the log only: no verdict ever depends on it. */
  toolName: string;
  capabilities: Capability[];
  card?: CardContext;
}

export type AirlockDenial = { decision: 'deny'; rule: AirlockRuleId; reason: string; target?: string };
export type AirlockApproval = {
  decision: 'needs-human-approval';
  rule: AirlockRuleId;
  reason: string;
  approvalKey: string;
  target?: string;
};
export type AirlockVerdict =
  | {
      decision: 'allow';
      why: 'mode-off' | 'model-not-selected' | 'no-rule-matched' | 'approved' | 'observe-mode';
      /** observe mode: the verdict enforce would have returned */
      observed?: AirlockDenial | AirlockApproval;
    }
  | AirlockDenial
  | AirlockApproval;

export interface StoredAirlockPolicy {
  scope: 'local' | 'hub';
  revision: number;
  policy: AirlockPolicy;
  updatedAt: string;
  updatedBy: string;
  /** 'local': written on this (standalone) installation; 'hub': adopted from the org's hub. No passkeys (2026-10-27). */
  authority: 'local' | 'hub';
  etag?: string | null;
}
