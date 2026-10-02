import { FEDERATION_HTTP_TIMEOUT_MS } from './federationSync.js';
import { parentHttpAgents, type ParentResolve } from './guardedLookup.js';

/**
 * Outbound calls a CHILD makes to its parent from an admin action, as opposed
 * to the background worker's transport. Injectable for the same reason: the
 * join route is otherwise untestable without a parent on the network.
 */
export interface FederationClient {
  enroll(args: { parentUrl: string; inviteToken: string; name: string; hubVersion?: string }): Promise<{
    token: string; childHubId: string; orgId?: string; parentUrl?: string;
    /** The group's policy, handed over at enrolment so the child never forwards under the wrong one. */
    identityPolicy?: 'keep' | 'pseudonymize';
  }>;
  requestRelease(args: { parentUrl: string; token: string; reason?: string | null }): Promise<unknown>;
}

export function httpFederationClient(
  axiosLike?: any,
  opts: { resolve?: ParentResolve } = {},
): FederationClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const axios = axiosLike ?? require('axios');
  // A parent has no business redirecting an enrolment or a release request:
  // following one would hand the invite — or the bearer token — elsewhere.
  // Every connection resolves through the DNS guard (CGLAB-371): the parent's
  // address is judged on the socket's own lookup, not on the hostname typed.
  // Always direct: through an HTTP(S)_PROXY the guard would judge the proxy
  // and the proxy would resolve the parent unchecked.
  const base = {
    timeout: FEDERATION_HTTP_TIMEOUT_MS, maxRedirects: 0, proxy: false as const,
    ...parentHttpAgents({ resolve: opts.resolve }),
  };
  return {
    async enroll({ parentUrl, inviteToken, name, hubVersion }) {
      const r = await axios.post(
        `${parentUrl}/v1/federation/enroll`,
        { inviteToken, childHub: { name, hubVersion } },
        base,
      );
      return r.data;
    },
    async requestRelease({ parentUrl, token, reason }) {
      const r = await axios.post(
        `${parentUrl}/v1/federation/release-request`,
        { reason },
        { ...base, headers: { Authorization: `Bearer ${token}` } },
      );
      return r.data;
    },
  };
}
