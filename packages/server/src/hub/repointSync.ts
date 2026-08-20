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
  // The hub derives allowed_host from the campaign's own target URL, so a
  // mismatch here means the directive was altered between them and us.
  if (parsed.hostname.toLowerCase() !== input.allowedHost.trim().toLowerCase()) {
    return {
      ok: false,
      error: `Target host "${parsed.hostname}" is not the campaign's allowed host "${input.allowedHost}"`,
    };
  }

  const base = input.targetUrl.replace(/\/$/, '');
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

    const target = directive.targetUrl.replace(/\/$/, '');
    if (target !== args.hubUrl.replace(/\/$/, '')) {
      args.writeConfigImpl({ url: target, token: args.hubToken, orgId: args.orgId });
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
