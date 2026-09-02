import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { PostHog } from 'posthog-node';
import { agenfkDir } from './serverPort.js';

const AGENFK_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

// Home paths resolve at CALL time (item 9c297075): module-level os.homedir()
// captures froze the machine home at import time — the hole behind the
// 2026-08-31 hub.json clobber. os.homedir() re-reads HOME on every call.
const configPath = () => path.join(agenfkDir(), 'config.json');
const installationIdPath = () => path.join(agenfkDir(), 'installation-id');
const hubConfigFile = () => path.join(agenfkDir(), 'hub.json');

// Exported for direct testing of the call-time (lazy) path resolution —
// the structural fix for the 2026-08-31 clobber incident (item 9c297075).
export { configPath, installationIdPath, hubConfigFile };

export type InstallSource = 'hub' | 'manual';

export function getInstallSource(): InstallSource {
  try {
    const raw = fs.readFileSync(hubConfigFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string' && parsed.url.length > 0) {
      return 'hub';
    }
    return 'manual';
  } catch {
    return 'manual';
  }
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function getOrCreateInstallationId(): string {
  try {
    const existing = fs.readFileSync(installationIdPath(), 'utf8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet — create it below
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(agenfkDir(), { recursive: true });
    fs.writeFileSync(installationIdPath(), id, 'utf8');
  } catch {
    // Fail silently — telemetry must never block normal operation
  }
  return id;
}

export class TelemetryClient {
  private client: PostHog | null = null;
  private installationId: string;
  private enabled: boolean;

  constructor() {
    const config = readConfig();
    // Default to enabled; only disable if explicitly set to false
    this.enabled = config.telemetry !== false;
    this.installationId = getOrCreateInstallationId();

    const apiKey = 'phc_QSEOhekLjn1ZAmwa2Gd43qr6WwaAK8dEhzgoS9XpuXW';
    if (this.enabled) {
      this.client = new PostHog(apiKey, {
        host: 'https://app.posthog.com',
        // Flush immediately so short-lived processes (CLI) don't lose events
        flushAt: 1,
        flushInterval: 0,
        // AgEnFK runs on the user's machine, so their IP is valid for geolocation
        disableGeoip: false,
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  get id(): string {
    return this.installationId;
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId: this.installationId,
        event,
        properties: {
          ...properties,
          $lib: 'agenfk',
          agenfk_version: AGENFK_VERSION,
          install_source: getInstallSource(),
        },
      });
    } catch {
      // Telemetry must never throw or crash calling code
    }
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown();
      } catch {
        // Fail silently
      }
    }
  }
}

/** Convenience: read installation ID without instantiating a full client */
export function getInstallationId(): string {
  return getOrCreateInstallationId();
}

/** Convenience: check opt-out flag without instantiating a full client */
export function isTelemetryEnabled(): boolean {
  const config = readConfig();
  return config.telemetry !== false;
}

export {
  agenfkDir,
  serverPortFile,
  DEFAULT_API_PORT,
  MAX_PORT_PROBE_ATTEMPTS,
  isPortAvailable,
  findAvailablePort,
  writeServerPortFile,
  removeServerPortFile,
  readServerPort,
  getApiUrl,
} from './serverPort.js';
