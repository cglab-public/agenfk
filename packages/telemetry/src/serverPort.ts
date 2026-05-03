import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const AGENFK_DIR = path.join(os.homedir(), '.agenfk');

export const SERVER_PORT_FILE = path.join(AGENFK_DIR, 'server-port');
export const DEFAULT_API_PORT = 3000;
export const MAX_PORT_PROBE_ATTEMPTS = 100;

export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    try {
      tester.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

export async function findAvailablePort(
  starting: number = DEFAULT_API_PORT,
  host = '127.0.0.1',
  maxAttempts: number = MAX_PORT_PROBE_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = starting + i;
    if (candidate > 65535) break;
    if (await isPortAvailable(candidate, host)) return candidate;
  }
  throw new Error(`No free port found starting at ${starting} after ${maxAttempts} attempts`);
}

export function writeServerPortFile(port: number): void {
  try {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(SERVER_PORT_FILE, String(port), 'utf8');
  } catch {
    // best-effort — discovery falls back to env vars / defaults
  }
}

export function removeServerPortFile(): void {
  try {
    fs.unlinkSync(SERVER_PORT_FILE);
  } catch {
    // ignore — file may already be gone
  }
}

export function readServerPort(): number | null {
  try {
    const raw = fs.readFileSync(SERVER_PORT_FILE, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

export function getApiUrl(): string {
  const explicit = process.env.AGENFK_API_URL;
  if (explicit) return explicit;
  const envPort = process.env.AGENFK_PORT || process.env.PORT;
  if (envPort) return `http://localhost:${envPort}`;
  const persisted = readServerPort();
  if (persisted) return `http://localhost:${persisted}`;
  return `http://localhost:${DEFAULT_API_PORT}`;
}
