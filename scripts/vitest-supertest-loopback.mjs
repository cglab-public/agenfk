import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Which loopback to dial for a server supertest bound.
 *
 * supertest calls `server.listen(0)` - the dual-stack wildcard `::` - and dials
 * the hard-coded http://127.0.0.1:<port>. macOS hands a wildcard bind a port
 * that another socket holds on 127.0.0.1 specifically, and the IPv4 connection
 * reaches THAT listener: a bare ECONNRESET (OrbStack holds one such port on the
 * dev machine permanently) or another app's 404/400/401. Dialling [::1] for a
 * `::` bind reaches our own socket; an IPv4-only listener cannot sit there.
 *
 * - `::` on macOS -> [::1]. Only macOS allows the colliding bind, and only
 *   there is ::1 guaranteed; a Linux container may have IPv6 sockets but no
 *   loopback ::1, where dialling it would break every request.
 * - `::1` (bound explicitly) -> [::1] everywhere: it exists, or bind failed.
 * - anything IPv4 -> unchanged.
 *
 * Remaining limit: a foreign listener bound to [::1]:P specifically (a dev
 * server on `localhost`, which Node resolves to ::1) could still collide on
 * macOS. Rarer than the IPv4 case this removes; a full fix needs an
 * asynchronous specific bind, which supertest's synchronous address() rules out.
 */
export function loopbackUrl(url, addr, platform = process.platform) {
  if (!addr || typeof addr !== 'object') return url;
  const v6 = addr.address === '::1' || (addr.address === '::' && platform === 'darwin');
  return v6 ? url.replace('://127.0.0.1:', '://[::1]:') : url;
}

/** Install loopbackUrl into supertest. Says so if it cannot. */
export function installSupertestLoopback() {
  let Test;
  try { Test = require('supertest/lib/test.js'); } catch { return () => {}; } // supertest not installed here
  const proto = Test?.prototype;
  if (!proto || typeof proto.serverAddress !== 'function') {
    // supertest resolved but its internals moved: the flake fix is OFF. Loud,
    // because a silently disabled fix looks exactly like a fixed flake.
    console.warn('[vitest-supertest-loopback] supertest has no Test.prototype.serverAddress; the loopback fix is NOT installed');
    return () => {};
  }
  if (proto.serverAddress.__agenfkLoopback) return () => {};
  const real = proto.serverAddress;
  proto.serverAddress = function (app, path) {
    const url = real.call(this, app, path);
    return loopbackUrl(url, typeof app?.address === 'function' ? app.address() : null);
  };
  proto.serverAddress.__agenfkLoopback = true;
  return () => { proto.serverAddress = real; };
}
