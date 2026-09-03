/**
 * Deterministically drain an Express app's ephemeral supertest listener.
 *
 * Why this exists: `supertest(app)` builds a `net.Server` (`app.listen(0)`) per
 * request and closes it when the response finishes. The hub's Express `app`
 * object *is* that server, so it keeps listening after the spec's last awaited
 * request. If the next thing a spec does is close a WAL-mode better-sqlite3 DB
 * (`db.close()` is synchronous), a response still draining can fail its write
 * mid-flight, the socket is reset, and the ECONNRESET surfaces on whichever
 * spec happens to be scheduled next — which is how
 * `installation-version-tracking > GET /v1/timeline` came to fail ~1 run in 3
 * while passing in isolation.
 *
 * `closeIdleConnections()` alone is not enough: an agent can hand a
 * keep-alive socket to a request that hasn't been dispatched yet, so it is not
 * "idle" and survives. `closeAllConnections()` destroys the rest.
 *
 * Safe to call on an app that never listened — `closeAllConnections` is a
 * no-op on a non-listening server.
 */
export async function drainApp(app: {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}): Promise<void> {
  app.closeIdleConnections?.();
  app.closeAllConnections?.();
  // One macrotask turn so the destroy callbacks (and any 'close'/'error'
  // handlers they fire) run before the caller tears down the DB.
  await new Promise<void>(resolve => setImmediate(resolve));
}
