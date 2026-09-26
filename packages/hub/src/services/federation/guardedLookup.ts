import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { isPrivateAddress } from './parentBinding.js';

/**
 * A DNS lookup for the sockets that dial a federation parent (CGLAB-371).
 *
 * The parent URL is an admin's input, and it used to be judged by its HOSTNAME
 * alone: a public name that resolves to 10.x - or that changes its answer
 * after the check (DNS rebinding) - was dialled wherever it pointed at connect
 * time. This lookup runs INSIDE the connection, so the address it judges is the
 * address the socket then uses; there is no second resolution to disagree
 * with. A refusal fails the connection before a single byte is sent, so an
 * invite or a bearer token never reaches the address.
 *
 * AGENFK_HUB_ALLOW_PRIVATE_PARENT=1 still admits a parent that really is on
 * the private network, exactly as the hostname check always has.
 *
 * Two things this does NOT cover, by design, and what does:
 *  - an IP-LITERAL parent URL never reaches a lookup at all (net connects to a
 *    literal directly). assertHttpUrl judges literals, with the same ranges.
 *  - an HTTP(S)_PROXY would make the socket's lookup resolve the PROXY, and
 *    the proxy would resolve the parent itself. The federation clients
 *    therefore always dial directly (`proxy: false`).
 */

type Addr = { address: string; family: number };
type Resolve = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: Addr[]) => void) => void;

const systemResolve: Resolve = (host, cb) =>
  dns.lookup(host, { all: true }, (err, addrs) => cb(err, (addrs as unknown as Addr[]) ?? []));

/** Read on every connection, like assertHttpUrl reads it on every request. */
export const allowPrivateParentFromEnv = (): boolean => process.env.AGENFK_HUB_ALLOW_PRIVATE_PARENT === '1';

export function guardedLookup(opts: { allowPrivate?: () => boolean; resolve?: Resolve } = {}) {
  const allowPrivate = opts.allowPrivate ?? allowPrivateParentFromEnv;
  const resolve = opts.resolve ?? systemResolve;
  // Node's lookup contract: (hostname, options, callback), where the callback
  // takes (err, address, family) - or (err, addresses[]) when options.all is
  // set, which is how autoSelectFamily ("Happy Eyeballs") asks.
  return (hostname: string, options: any, callback?: any): void => {
    if (typeof options === 'function') { callback = options; options = {}; }
    resolve(hostname, (err, addrs) => {
      if (err) { callback(err); return; }
      if (!addrs.length) {
        callback(Object.assign(new Error(`could not resolve ${hostname}`), { code: 'ENOTFOUND' }));
        return;
      }
      if (!allowPrivate()) {
        // ANY private answer refuses: the socket may pick any of them.
        const bad = addrs.find((a) => isPrivateAddress(a.address));
        if (bad) {
          // The address goes to the server log, not to the admin: on a
          // multi-org hub an org admin is not the operator, and echoing it
          // would make this check an oracle for internal DNS.
          console.warn(`[FEDERATION] refused ${hostname}: it resolves to ${bad.address}, a private or loopback address`);
          callback(Object.assign(new Error(
            `refusing to connect to ${hostname}: it resolves to a private or loopback address. `
              + 'Set AGENFK_HUB_ALLOW_PRIVATE_PARENT=1 if the parent hub really is on this network.',
          ), { code: 'EPRIVATEADDR' }));
          return;
        }
      }
      const wanted = options?.family === 4 || options?.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
      const list = wanted.length ? wanted : addrs;
      if (options?.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

/** http/https agents whose every connection resolves through the guard. */
export type ParentResolve = Resolve;

export function parentHttpAgents(opts: { allowPrivate?: () => boolean; resolve?: Resolve } = {}) {
  const lookup = guardedLookup(opts) as any;
  return { httpAgent: new http.Agent({ lookup }), httpsAgent: new https.Agent({ lookup }) };
}
