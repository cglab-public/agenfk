/**
 * Fail loudly when a test opens a socket to anything but loopback.
 *
 * Unit tests must be insulated from external dependencies. They were not: a
 * single `npm test` made 24 real HTTPS requests to app.posthog.com (one per
 * packages/server test file, from TelemetryClient's constructor), and the hub's
 * federation worker would dial whatever host a stored parent binding named. The
 * visible symptom was an intermittent `read ECONNRESET` that moved between files
 * run to run — a real remote connection being reset — which repeatedly rolled
 * workflow gates backwards. The invisible symptom was worse: every developer's
 * and every CI test run shipped analytics to a third party.
 *
 * A guard belongs here rather than in each test because the failure mode is
 * silence: a new unmocked client re-introduces the flake without anyone noticing
 * until it resets somebody's unrelated file weeks later. Failing at the moment
 * of connection names the culprit instead.
 *
 * Loopback stays allowed: supertest binds an ephemeral 127.0.0.1 port for every
 * request, and several suites stand up real local servers on purpose.
 *
 * Set AGENFK_TEST_ALLOW_NETWORK=1 for the rare test that genuinely needs the
 * network (nothing in this repo does today).
 */
import { Socket } from 'net';

/** Unix sockets and every loopback spelling, including IPv4-mapped IPv6. */
export function isLocalHost(host) {
  if (!host) return true;                       // no host === a local/unix connect
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h.startsWith('/')) return true;           // unix domain socket
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) return isLocalHost(mapped[1]);
  return false;
}

/** The host a net.Socket.connect(...) call is aiming at. */
export function connectTarget(args) {
  const a0 = args[0];
  if (a0 && typeof a0 === 'object') return a0.host ?? a0.path ?? '';
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
    // connect(port[, host]) — host omitted defaults to localhost
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  return a0 ?? '';                              // connect(path) — unix socket
}

export function installNetGuard() {
  if (process.env.AGENFK_TEST_ALLOW_NETWORK === '1') return () => {};
  const real = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const host = connectTarget(args);
    if (!isLocalHost(host)) {
      throw new Error(
        `[net-guard] A test tried to open a real network connection to "${host}".\n`
        + 'Unit tests must not depend on external services — mock the client, or inject a fake\n'
        + 'transport. If this connection is genuinely required, set AGENFK_TEST_ALLOW_NETWORK=1.',
      );
    }
    return real.apply(this, args);
  };
  return () => { Socket.prototype.connect = real; };
}
