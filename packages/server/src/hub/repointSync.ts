import axios from 'axios';
import { HubConfig } from './types.js';

/**
 * Repoint campaign — client side (CGLAB-66).
 *
 * A hub can move DNS name without anyone rejoining: clients hold only
 * {url, token, orgId} and api keys are org-scoped, not host-scoped. This is the
 * push-down half — polling /v1/repoint-directive and applying it.
 *
 * The directive carries a URL, which makes it a fleet-hijack primitive if
 * trusted blindly: one compromised or spoofed response could point an entire
 * org at an attacker's endpoint, handing over org telemetry and a live bearer
 * token. So this module re-runs the same identity checks `agenfk hub repoint`
 * performs before rewriting hub.json, and refuses any target outside the
 * campaign's own allowed host. Same defense-in-depth stance as upgradeSync's
 * local semver allowlist: the hub validating its own input is not a reason for
 * the fleet machine to skip validating what it received.
 */

export interface RepointDirective {
  campaignId: string;
  targetUrl: string;
  allowedHost: string;
}

export type FetchRepointImpl = (input: {
  hubUrl: string;
  hubToken: string;
  installationId: string;
}) => Promise<{ status: number; json: () => Promise<any> }>;

/** Minimal GET, injectable so verification is testable without a network. */
export type GetImpl = (url: string, opts?: { headers?: Record<string, string> }) => Promise<{ status: number; data: any }>;

export interface RecordRepointEvent {
  (input: {
    installationId: string;
    type: 'hub:repoint:succeeded' | 'hub:repoint:blocked' | 'hub:repoint:failed';
    payload: any;
  }): void;
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Hosts a campaign may never point at. Every fleet machine fetches the target
 * with its live bearer token, so an unconstrained target turns a campaign into
 * a token-harvest and an internal-host enumeration probe run from every dev
 * laptop in the org.
 *
 * This is a syntactic guard, not a substitute for network policy: a public name
 * resolving to a private address still gets through, and DNS can change between
 * check and use.
 */
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  }
  return false;
}

const defaultGet: GetImpl = (url, opts) =>
  axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: opts?.headers });

/**
 * Is this endpoint really our hub, for our org, reachable with the token we
 * already hold? Mirrors packages/cli/src/commands/hub.ts `hub repoint`.
 *
 * Order matters: the /healthz identity check runs first so a wrong-service
 * target is reported as such rather than as an auth failure, which is what an
 * operator needs to see when a DNS name points somewhere unexpected.
 */
export async function verifyRepointTarget(input: {
  targetUrl: string;
  allowedHost: string;
  token: string;
  orgId: string;
  getImpl?: GetImpl;
}): Promise<VerifyResult> {
  const get = input.getImpl ?? defaultGet;
  let parsed: URL;
  try {
    parsed = new URL(input.targetUrl);
  } catch {
    return { ok: false, error: `Target "${input.targetUrl}" is not an absolute URL` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Refusing a non-https hub target: it would ship telemetry and a bearer token in clear' };
  }
  if (parsed.username || parsed.password) {
    // Would send basic-auth credentials to the real hub while still passing a
    // host comparison.
    return { ok: false, error: 'Refusing a hub target that carries userinfo' };
  }
  // Exact host match, so hub.new.example.evil.test cannot pass as
  // hub.new.example. Note the allow-list arrives in the same response as the
  // target, so this defends against a mangled or truncated directive — NOT
  // against a hub that is itself compromised, which would simply send a
  // consistent pair. Constraining that is an operator-side allow-list.
  if (parsed.hostname.toLowerCase() !== input.allowedHost.trim().toLowerCase()) {
    return {
      ok: false,
      error: `Target host "${parsed.hostname}" is not the campaign's allowed host "${input.allowedHost}"`,
    };
  }
  if (isDisallowedHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Refusing "${parsed.hostname}": private, loopback, link-local and internal addresses are not valid hub targets`,
    };
  }

  // Probe the ORIGIN. Chopping the raw string would turn
  // "https://h/?x=1" into "https://h/?x=1/healthz".
  const base = parsed.origin;
  try {
    const { data } = await get(`${base}/healthz`);
    if (!data || typeof data !== 'object' || (data as any).service !== 'agenfk-hub') {
      return {
        ok: false,
        error: `${base}/healthz did not identify as agenfk-hub (got service=${(data as any)?.service ?? 'absent'})`,
      };
    }
  } catch (e: any) {
    return { ok: false, error: `Cannot reach ${base}/healthz — ${e?.message ?? e}` };
  }

  try {
    const { data } = await get(`${base}/v1/ping`, { headers: { Authorization: `Bearer ${input.token}` } });
    if (data?.orgId !== input.orgId) {
      return { ok: false, error: `${base} reports org "${data?.orgId}" but we belong to "${input.orgId}"` };
    }
  } catch (e: any) {
    return { ok: false, error: `${base}/v1/ping rejected our existing token — ${e?.message ?? e}` };
  }
  return { ok: true };
}

const defaultFetch: FetchRepointImpl = async ({ hubUrl, hubToken, installationId }) => {
  const resp = await axios.get(`${hubUrl.replace(/\/$/, '')}/v1/repoint-directive`, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${hubToken}`, 'X-Installation-Id': installationId },
    validateStatus: () => true,
  } as any);
  return { status: resp.status, json: async () => resp.data };
};

export interface ReconcileRepointArgs {
  hubUrl: string;
  hubToken: string;
  orgId: string;
  installationId: string;
  /** Value of AGENFK_HUB_URL, which overrides hub.json entirely. */
  envHubUrl?: string | null;
  writeConfigImpl: (cfg: HubConfig) => void;
  /**
   * Point this process's hub transport at the new config. Required, because the
   * flusher's baseURL is fixed at construction and nothing re-reads hub.json —
   * without it the success report goes to the OLD host, the hub refuses it, and
   * the target is reset to pending on every tick forever.
   */
  rebuildTransportImpl?: (cfg: HubConfig) => Promise<void>;
  recordEvent: RecordRepointEvent;
  flushNow: (timeoutMs?: number) => Promise<void>;
  fetchImpl?: FetchRepointImpl;
  getImpl?: GetImpl;
}

let inflight = false;

/** Test-only: clear the concurrency guard between cases. */
export function __resetRepointInflight(): void {
  inflight = false;
}

/** One polling tick. Never throws — a failed tick simply retries next time. */
export async function reconcileRepointDirective(args: ReconcileRepointArgs): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const fetchImpl = args.fetchImpl ?? defaultFetch;
    let directive: RepointDirective;
    try {
      const resp = await fetchImpl({
        hubUrl: args.hubUrl,
        hubToken: args.hubToken,
        installationId: args.installationId,
      });
      if (resp.status !== 200) return; // 204 → nothing pending; anything else → ignore
      const body = await resp.json();
      if (!body
        || typeof body.campaignId !== 'string' || !body.campaignId
        || typeof body.targetUrl !== 'string' || !body.targetUrl
        || typeof body.allowedHost !== 'string' || !body.allowedHost) {
        return; // unrecognised shape — say nothing rather than report noise
      }
      directive = body as RepointDirective;
    } catch {
      return; // hub unreachable; the next tick tries again
    }

    const report = async (
      type: 'hub:repoint:succeeded' | 'hub:repoint:blocked' | 'hub:repoint:failed',
      payload: any,
    ) => {
      args.recordEvent({ installationId: args.installationId, type, payload });
      // Push immediately. For a success this is what makes the report arrive on
      // the NEW hostname, which is the only evidence the hub accepts.
      try { await args.flushNow(5_000); } catch { /* stays in the outbox */ }
    };

    // AGENFK_HUB_URL wins over hub.json (see hubClient.loadHubConfig), so
    // rewriting the file would change nothing. Reporting success here would put
    // a machine on the board as moved while it keeps using the old name — and
    // the old DNS record would then be dropped out from under it.
    if (args.envHubUrl) {
      await report('hub:repoint:blocked', {
        campaignId: directive.campaignId,
        reason: `AGENFK_HUB_URL is set to ${args.envHubUrl} and overrides hub.json; `
              + 'update that environment variable to complete the move.',
      });
      return;
    }

    const verdict = await verifyRepointTarget({
      targetUrl: directive.targetUrl,
      allowedHost: directive.allowedHost,
      token: args.hubToken,
      orgId: args.orgId,
      getImpl: args.getImpl,
    });
    if (!verdict.ok) {
      await report('hub:repoint:failed', { campaignId: directive.campaignId, error: verdict.error });
      return;
    }

    const target = new URL(directive.targetUrl).origin;
    const cfg: HubConfig = { url: target, token: args.hubToken, orgId: args.orgId };
    if (target !== args.hubUrl.replace(/\/$/, '')) {
      args.writeConfigImpl(cfg);
      if (args.rebuildTransportImpl) {
        try {
          await args.rebuildTransportImpl(cfg);
        } catch (e: any) {
          // Reporting now would push the confirmation through the old transport,
          // where the hub rightly refuses it and resets us to pending — leaving
          // an error on the board the admin cannot act on. Stay quiet and let
          // the next tick retry.
          console.error('[HUB_REPOINT_SYNC] could not rebuild transport:', e?.message ?? e);
          return;
        }
      }
      // Follow the move ourselves. startRepointSync closes over this same args
      // object, so without this every later tick would still see the old url and
      // repoint again — rewriting the file and rebuilding the transport on a
      // loop for as long as the campaign stays open.
      args.hubUrl = target;
    }
    // Confirm even when already on the target: the hub still needs the report
    // to move this target out of pending, or the campaign never drains.
    await report('hub:repoint:succeeded', { campaignId: directive.campaignId, url: target });
  } finally {
    inflight = false;
  }
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface RepointSyncHandle { stop: () => void }

export interface StartRepointSyncArgs extends ReconcileRepointArgs {
  intervalMs?: number;
}

/**
 * Poll for a repoint campaign. Deliberately slow (5min default): a campaign is
 * a rare administrative event and every tick is a request the old hostname has
 * to keep serving until the fleet drains.
 */
export function startRepointSync(args: StartRepointSyncArgs): RepointSyncHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const interval = args.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    try {
      await reconcileRepointDirective(args);
    } catch (e) {
      console.error('[HUB_REPOINT_SYNC] tick failed:', (e as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 3_000);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
