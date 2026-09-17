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

    // Never under a test runner.
    //
    // The client below is built with flushAt:1 / flushInterval:0 — send
    // immediately — and every packages/server test file imports the server,
    // constructs one and captures events. That was 24 real HTTPS requests to
    // app.posthog.com per `npm test`: a third party receiving analytics from
    // every developer's and every CI test run, and a pile of live sockets whose
    // resets showed up as the intermittent `read ECONNRESET` that wandered
    // between unrelated files. Set AGENFK_TEST_ENABLE_TELEMETRY=1 in the rare
    // test that actually wants the client.
    if ((process.env.NODE_ENV === 'test' || !!process.env.VITEST)
      && process.env.AGENFK_TEST_ENABLE_TELEMETRY !== '1') {
      this.enabled = false;
    }

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

  /**
   * Whether anything would actually be sent right now.
   *
   * Asks the file rather than the boolean captured at construction, for the
   * same reason `capture` does: a caller that checks this before doing work
   * must not be told "on" over a switch the user turned off a minute ago.
   */
  get isEnabled(): boolean {
    return this.enabled && this.client !== null && isTelemetryEnabled();
  }

  get id(): string {
    return this.installationId;
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.client) return;
    /*
     * The flag is re-read HERE, not only in the constructor.
     *
     * The constructor's copy was safe for as long as the only writer was
     * `agenfk config set telemetry`, because that is a fresh process every
     * time. The settings screen is the first IN-PROCESS opt-out: the route
     * writes config.json and answers "off", and the long-lived server holds a
     * client built from what the flag said at boot. Events keep going out until
     * the next restart, over a switch the user has just watched turn off.
     *
     * A file read per captured event is affordable - these are user-scale
     * events (a card created, a step advanced), not a hot loop - and the
     * alternative is a setter that every future writer has to remember to call.
     */
    if (!isTelemetryEnabled()) return;
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

/**
 * Record the opt-in/opt-out choice, next to the only thing that reads it.
 *
 * `agenfk config set telemetry` wrote this file itself, inline in the command,
 * and that was fine while the CLI was the only writer. The settings screen is a
 * second one. Two hand-rolled read-modify-writes over the same JSON is how a
 * config file loses the keys the other writer did not know about — flowRegistry
 * and the GitHub repo mappings live in here, and the JIRA credentials will.
 *
 * Deliberately NOT `readConfig()`, which answers `{}` for a file it cannot
 * parse. That is the right reading for "tell me the flag" and the wrong one
 * here: writing `{telemetry:false}` over unparseable JSON throws away whatever
 * was in it, including credentials the user cannot regenerate. Refusing is
 * recoverable; a silent overwrite is not.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  const file = configPath();
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // Throws on malformed JSON, on purpose. See above.
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  config.telemetry = enabled;
  // The directory may not exist: this screen is reachable on a machine where no
  // agenfk command has ever been typed.
  fs.mkdirSync(agenfkDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
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
