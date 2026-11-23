/**
 * Hub discovery (INFRA-463): find the corporate Hub without being told.
 *
 * Sources, in order:
 *   env (AGENFK_HUB_URL) > managed file (written by MDM)
 *   > user file (~/.agenfk/hub.json) > DNS TXT _agenfk-hub.<git email domain>
 *
 * A candidate counts only over https and only when GET <url>/healthz answers
 * service=agenfk-hub with 200. A missing or malformed source is a reason,
 * never a throw, and discovery moves on. A source that names a URL (env, a
 * readable managed file, a readable user file) is final: if its Hub is
 * refused, discovery stops there, so taking that Hub down cannot steer the
 * login to a lower source. A DNS candidate must sit on the email's domain.
 * `hub login --url` does not come through here: the flag is taken as given.
 * No source carries a secret: identity still comes from `agenfk hub login`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promises as dns } from 'dns';
import { execFile } from 'child_process';
import axios from 'axios';

/** Upper bound for every network call discovery makes (DNS and /healthz). */
export const DISCOVERY_TIMEOUT_MS = 3000;

/** 'flag' is never produced by discoverHub; `hub login --url` records it. */
export type HubSource = 'flag' | 'env' | 'managed' | 'user' | 'dns';

export interface DiscoveryDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: () => string;
  readFile: (p: string) => Promise<string>;
  gitEmail: () => Promise<string | null>;
  resolveTxt: (name: string) => Promise<string[][]>;
  httpGet: (url: string, opts: { timeoutMs: number }) => Promise<{ status: number; data: any }>;
}

export interface DiscoveryResult {
  url: string | null;
  source?: HubSource;
  orgId?: string;
  /** Why each source that was tried did not match. */
  reasons: string[];
}

/**
 * Where MDM drops the managed config on each platform. WSL reports linux.
 * Windows uses Program Files, which only an admin can write: a standard user
 * can create folders under ProgramData, and so could plant the file there.
 */
export function managedConfigPath(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === 'win32') {
    return path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'AgEnFK', 'managed.json');
  }
  if (platform === 'darwin') return '/Library/Application Support/AgEnFK/managed.json';
  return '/etc/agenfk/managed.json';
}

/**
 * Parse one TXT record: `v=agenfk1; url=https://...; org=<id>`. Returns null
 * for a record that is not ours (no or another version) or that has no url.
 */
export function parseHubTxt(value: string): { url: string; orgId?: string } | null {
  const fields: Record<string, string> = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  if (fields.v?.toLowerCase() !== 'agenfk1' || !fields.url) return null;
  return fields.org ? { url: fields.url, orgId: fields.org } : { url: fields.url };
}

class TimeoutError extends Error {}

/** Race a promise against a timer, so a call that never answers cannot hold discovery. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errText(e: any): string {
  return String(e?.message ?? e);
}

function gitConfig(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 1500, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

function defaultDeps(): DiscoveryDeps {
  return {
    env: process.env,
    platform: process.platform,
    homedir: () => os.homedir(),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    // Global first: the repo value depends on the directory `hub login` runs in.
    gitEmail: async () => (await gitConfig(['config', '--global', '--get', 'user.email']))
      ?? gitConfig(['config', '--get', 'user.email']),
    resolveTxt: (name) => new dns.Resolver({ timeout: DISCOVERY_TIMEOUT_MS, tries: 1 }).resolveTxt(name),
    httpGet: async (url, { timeoutMs }) => {
      // No redirects: the probe must vouch for the origin it was given.
      const r = await axios.get(url, { timeout: timeoutMs, maxRedirects: 0, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
  };
}

export async function discoverHub(partial: Partial<DiscoveryDeps> = {}): Promise<DiscoveryResult> {
  const deps: DiscoveryDeps = { ...defaultDeps(), ...partial };
  const reasons: string[] = [];

  /** https-only plus the /healthz identity check. Returns the normalised URL or null. */
  const accept = async (raw: string, label: string): Promise<string | null> => {
    const url = raw.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reasons.push(`${label}: "${raw}" is not a URL`);
      return null;
    }
    if (parsed.protocol !== 'https:') {
      reasons.push(`${label}: ${url} refused, only https is accepted`);
      return null;
    }
    try {
      const { status, data } = await withTimeout(
        deps.httpGet(`${url}/healthz`, { timeoutMs: DISCOVERY_TIMEOUT_MS }),
        DISCOVERY_TIMEOUT_MS,
      );
      if (status === 200 && data && data.service === 'agenfk-hub') return url;
      reasons.push(`${label}: ${url}/healthz did not identify as agenfk-hub (status ${status}, service=${data?.service ?? 'absent'})`);
    } catch (e) {
      reasons.push(`${label}: cannot reach ${url}/healthz (${errText(e)})`);
    }
    return null;
  };

  /** Read a JSON file; a missing file, unreadable file or bad JSON is a reason. */
  const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
    let text: string;
    try {
      text = await deps.readFile(p);
    } catch (e: any) {
      reasons.push(e?.code === 'ENOENT' ? `${p}: not present` : `${p}: unreadable (${errText(e)})`);
      return null;
    }
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      reasons.push(`${p}: malformed, expected a JSON object`);
    } catch (e) {
      reasons.push(`${p}: malformed JSON (${errText(e)})`);
    }
    return null;
  };

  // 1. AGENFK_HUB_URL (empty counts as unset). Final once set.
  const envUrl = deps.env.AGENFK_HUB_URL?.trim();
  if (envUrl) {
    const url = await accept(envUrl, 'AGENFK_HUB_URL');
    return url ? { url, source: 'env', reasons } : { url: null, reasons };
  } else {
    reasons.push('AGENFK_HUB_URL: not set');
  }

  // 2. Managed file
  const managedPath = managedConfigPath(deps.platform, deps.env);
  const managed = await readJson(managedPath);
  if (managed) {
    if (typeof managed.hubUrl !== 'string') {
      reasons.push(`${managedPath}: no string "hubUrl" field`);
    } else {
      const url = await accept(managed.hubUrl, managedPath);
      if (!url) return { url: null, reasons };
      return {
        url, source: 'managed', reasons,
        ...(typeof managed.orgId === 'string' ? { orgId: managed.orgId } : {}),
      };
    }
  }

  // 3. ~/.agenfk/hub.json
  const userPath = path.join(deps.homedir(), '.agenfk', 'hub.json');
  const user = await readJson(userPath);
  if (user) {
    if (typeof user.url !== 'string') {
      reasons.push(`${userPath}: no string "url" field`);
    } else {
      const url = await accept(user.url, userPath);
      if (!url) return { url: null, reasons };
      return { url, source: 'user', reasons, ...(typeof user.orgId === 'string' ? { orgId: user.orgId } : {}) };
    }
  }

  // 4. DNS TXT _agenfk-hub.<domain of git user.email>
  let email: string | null;
  try {
    email = await deps.gitEmail();
  } catch (e) {
    reasons.push(`DNS: git config user.email could not be read (${errText(e)}), lookup skipped`);
    return { url: null, reasons };
  }
  if (!email) {
    reasons.push('DNS: git config user.email is not set, lookup skipped');
    return { url: null, reasons };
  }
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
  if (!domain) {
    reasons.push(`DNS: git user.email "${email}" has no domain, lookup skipped`);
    return { url: null, reasons };
  }
  const name = `_agenfk-hub.${domain}`;
  let records: string[][];
  try {
    records = await withTimeout(deps.resolveTxt(name), DISCOVERY_TIMEOUT_MS);
  } catch (e: any) {
    if (e instanceof TimeoutError) reasons.push(`${name}: DNS lookup timed out after ${DISCOVERY_TIMEOUT_MS} ms`);
    else if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') reasons.push(`${name}: no TXT record`);
    else reasons.push(`${name}: DNS lookup failed (${errText(e)})`);
    return { url: null, reasons };
  }
  let ours = 0;
  for (const chunks of records) {
    // A TXT record longer than 255 bytes arrives split into strings.
    const value = chunks.join('');
    const parsed = parseHubTxt(value);
    if (!parsed) {
      if (/^\s*v\s*=\s*agenfk1\s*(;|$)/i.test(value)) {
        ours++;
        reasons.push(`${name}: malformed record "${value}" (needs url=https://...)`);
      }
      continue;
    }
    ours++;
    // TXT answers are unauthenticated. Requiring the host to be the email's
    // domain or under it means a spoofed record also needs a valid
    // certificate for that domain to get past https.
    // The https refusal in accept() comes first; this only judges https hosts.
    let host = '';
    try {
      const u = new URL(parsed.url.trim());
      if (u.protocol === 'https:') host = u.hostname.toLowerCase();
    } catch { /* accept() reports it */ }
    if (host && host !== domain && !host.endsWith(`.${domain}`)) {
      reasons.push(`${name}: ${parsed.url} refused, a DNS-discovered Hub must be on ${domain} or a subdomain of it`);
      continue;
    }
    const url = await accept(parsed.url, name);
    if (url) return { url, source: 'dns', reasons, ...(parsed.orgId ? { orgId: parsed.orgId } : {}) };
  }
  if (ours === 0) reasons.push(`${name}: no v=agenfk1 record`);
  return { url: null, reasons };
}
