export interface HubServerConfig {
  dbPath: string;
  secretKey: string;          // AES-256-GCM key (hex or base64, 32 bytes)
  sessionSecret: string;      // HMAC key for session JWTs
  defaultOrgId: string;       // single-tenant v1: one org per hub deployment
  initialAdminEmail?: string;
  initialAdminPassword?: string;
  /**
   * Validates that a given agenfk version actually exists as a published
   * release. Used by the fleet-upgrade-directive admin POST so we never fan
   * out a directive that no installation can resolve. Defaults to a GitHub
   * Releases lookup at runtime; tests inject a stub.
   */
  releaseExists?: (version: string) => Promise<boolean>;
}

export interface SessionPayload {
  userId: string;
  orgId: string;
  role: 'admin' | 'viewer';
}
