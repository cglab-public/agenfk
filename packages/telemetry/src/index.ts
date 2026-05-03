import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { PostHog } from 'posthog-node';

const AGENFK_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const AGENFK_DIR = path.join(os.homedir(), '.agenfk');
const CONFIG_PATH = path.join(AGENFK_DIR, 'config.json');
const INSTALLATION_ID_PATH = path.join(AGENFK_DIR, 'installation-id');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getOrCreateInstallationId(): string {
  try {
    const existing = fs.readFileSync(INSTALLATION_ID_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet — create it below
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(INSTALLATION_ID_PATH, id, 'utf8');
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
        properties: { ...properties, $lib: 'agenfk', agenfk_version: AGENFK_VERSION },
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
  SERVER_PORT_FILE,
  DEFAULT_API_PORT,
  MAX_PORT_PROBE_ATTEMPTS,
  isPortAvailable,
  findAvailablePort,
  writeServerPortFile,
  removeServerPortFile,
  readServerPort,
  getApiUrl,
} from './serverPort.js';
