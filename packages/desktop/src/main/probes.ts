/**
 * Deciding what is on a port — and whether we want it.
 *
 * "Something answered 200" is not enough. Adoption is unconditional once a
 * probe succeeds, so a weak probe hands the window to whatever else happens to
 * be on port 3000: a Vite or Next dev server with an SPA catch-all answers 200
 * for /version like it answers 200 for everything, and the app would open a
 * chrome-less window on someone else's application with our preload injected.
 *
 * These predicates therefore read the body. The HTTP call is injected so they
 * stay testable without a socket.
 */
import * as http from 'http';

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

/** Perform a GET and read the body; null when nothing usable came back. */
export type HttpGet = (
  port: number,
  path: string,
  headers?: Record<string, string>,
) => Promise<HttpResponse | null>;

const BODY_LIMIT = 64 * 1024;

/**
 * Total time a probe may take, end to end.
 *
 * Node's `timeout` option is an INACTIVITY timer, not a wall clock: a server
 * that dribbles a byte every so often resets it forever, so a promise that
 * settles only on 'end' never settles. Since resolveServer awaits this, the
 * app would then never spawn, never throw, and never open a window — a dock
 * icon and nothing else, indefinitely. This deadline is what makes the
 * "gives up with a clear error" promise actually true.
 */
const REQUEST_DEADLINE_MS = 2000;

/** Real implementation: loopback GET, bounded in both time and bytes. */
export const httpGet: HttpGet = (port, reqPath, headers = {}) =>
  new Promise(resolve => {
    let settled = false;
    let request: http.ClientRequest | null = null;

    const finish = (value: HttpResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve(value);
    };

    const deadline = setTimeout(() => finish(null), REQUEST_DEADLINE_MS);

    request = http.get(
      { host: '127.0.0.1', port, path: reqPath, headers, timeout: REQUEST_DEADLINE_MS },
      res => {
        const snapshot = (body: string): HttpResponse => ({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body,
        });
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          // We only ever inspect a short banner. Once we have more than enough,
          // answer and hang up rather than stay open for a server we do not
          // control — which may never send an end.
          if (body.length >= BODY_LIMIT) finish(snapshot(body.slice(0, BODY_LIMIT)));
        });
        res.on('end', () => finish(snapshot(body)));
        res.on('error', () => finish(null));
      },
    );
    request.on('error', () => finish(null));
    request.on('timeout', () => finish(null));
  });

/** The banner GET / returns to an API client. Our actual signature. */
const API_BANNER = 'AgEnFK Framework API is running';

/**
 * Is an AgEnFK API server listening here?
 *
 * `/version` returning JSON with a string `version` is necessary but nowhere
 * near sufficient — `res.json({version: pkg.version})` is Express boilerplate,
 * and 3000 is the most contested port on a developer machine. So we also read
 * the banner from `GET /`, which is ours specifically. Getting this wrong
 * means adopting a stranger's server and showing it in a chrome-less window.
 */
export async function isAgenfkServer(port: number, get: HttpGet = httpGet): Promise<boolean> {
  const version = await get(port, '/version');
  if (!version || version.status !== 200) return false;
  if (!version.contentType.includes('json')) return false;
  try {
    const parsed = JSON.parse(version.body);
    const looksRight = !!parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof parsed.version === 'string';
    if (!looksRight) return false;
  } catch {
    return false;
  }

  // Second, specific signal. Sent without an Accept preference so the server
  // negotiates to JSON even when it is also serving the UI bundle.
  const root = await get(port, '/');
  return !!root && root.status === 200 && root.body.includes(API_BANNER);
}

/**
 * Does this server also serve the UI bundle? The server `agenfk up` starts
 * does not — it answers GET / with its JSON banner and leaves the UI to
 * `vite preview` — and a window pointed at it would render that banner
 * instead of the board.
 */
export async function servesUiBundle(port: number, get: HttpGet = httpGet): Promise<boolean> {
  const res = await get(port, '/', { Accept: 'text/html,application/xhtml+xml' });
  return !!res && res.status === 200 && res.contentType.includes('text/html');
}
