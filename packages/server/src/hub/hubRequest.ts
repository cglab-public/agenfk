/**
 * GH-346 — every request this installation makes to the hub gives up after a
 * deadline. A hub that accepts a connection and never answers (a target being
 * drained mid-deploy) used to hold a sync for as long as Node's own 5-minute
 * defaults allowed, per request; one bounded request per channel is the most a
 * hung hub can cost now.
 */

/** How long a hub request may take, start to finish. */
export const HUB_REQUEST_TIMEOUT_MS = 15_000;

/** The deadline in force: AGENFK_HUB_REQUEST_TIMEOUT_MS when it is a positive number. */
export function hubRequestTimeoutMs(): number {
  const n = Number(process.env.AGENFK_HUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : HUB_REQUEST_TIMEOUT_MS;
}

/**
 * The deadline as a signal, fresh per request. axios callers pass it as `signal`:
 * axios's own `timeout` stops counting once the headers arrive, so a hub that
 * drips the body would hold the request for as long as it dripped.
 */
export function hubRequestSignal(): AbortSignal {
  return AbortSignal.timeout(hubRequestTimeoutMs());
}

/**
 * `fetch` with the deadline. A caller that brings its own signal keeps it: it
 * chose its deadline (a flow publish is allowed two minutes) or aborts itself.
 * Looked up at call time, so a test that stubs the global fetch reaches its stub.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hubFetch(url: string, init: Record<string, any> = {}): Promise<any> {
  return globalThis.fetch(url, { ...init, signal: init.signal ?? hubRequestSignal() });
}
