export interface HubServerConfig {
  /** Injected in tests so the child's join route needs no parent on the network. */
  federationClient?: unknown;
  dbPath: string;
  secretKey: string;          // AES-256-GCM key (hex or base64, 32 bytes)
  sessionSecret: string;      // HMAC key for session JWTs
  defaultOrgId: string;       // single-tenant v1: one org per hub deployment
  /**
   * Express `trust proxy`: how many reverse proxies stand in front of the hub
   * (a hop count), or which addresses are proxies (a CIDR/`loopback` list).
   * Decides which X-Forwarded-For hop is the client, and so which bucket every
   * rate limit charges. 0 = exposed directly. Defaults to 1 (see configFromEnv).
   */
  trustProxy?: number | string;
  /**
   * Validates that a given agenfk version actually exists as a published
   * release. Used by the fleet-upgrade-directive admin POST so we never fan
   * out a directive that no installation can resolve. Defaults to a GitHub
   * Releases lookup at runtime; tests inject a stub.
   */
  releaseExists?: (version: string) => Promise<boolean>;
  /**
   * The transport the child-side federation WORKER talks to its parent
   * through, and how often it runs.
   *
   * Injected in tests, defaulting to the real HTTP transport and a one-minute
   * tick. Without this seam the worker could only ever be driven by calling
   * federationTick directly, which means the standalone guarantee — that a
   * parent which is down or SLOW is invisible to this hub's own people —
   * could be asserted but never actually exercised end to end.
   */
  federationTransport?: unknown;
  federationIntervalMs?: number;
}

export interface SessionPayload {
  userId: string;
  orgId: string;
  role: 'admin' | 'viewer';
}
