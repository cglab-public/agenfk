export interface HubServerConfig {
  dbPath: string;
  secretKey: string;          // AES-256-GCM key (hex or base64, 32 bytes)
  sessionSecret: string;      // HMAC key for session JWTs
  defaultOrgId: string;       // single-tenant v1: one org per hub deployment
  initialAdminEmail?: string;
  initialAdminPassword?: string;
}

export interface SessionPayload {
  userId: string;
  orgId: string;
  role: 'admin' | 'viewer';
}
