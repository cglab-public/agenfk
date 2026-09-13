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

/** Real implementation: loopback GET with a hard timeout and a body cap. */
export const httpGet: HttpGet = (port, reqPath, headers = {}) =>
  new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port, path: reqPath, headers, timeout: 1500 },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          // Cap it: we only ever inspect a short banner, and an adopted server
          // we do not control could stream forever.
          if (body.length < BODY_LIMIT) body += chunk;
        });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body,
        }));
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });

/**
 * Is an AgEnFK API server listening here? Checks that /version returns JSON
 * with a string `version` — the shape only our server produces. An SPA
 * catch-all returns HTML and is rejected; another JSON service without that
 * field is rejected too.
 */
export async function isAgenfkServer(port: number, get: HttpGet = httpGet): Promise<boolean> {
  const res = await get(port, '/version');
  if (!res || res.status !== 200) return false;
  if (!res.contentType.includes('json')) return false;
  try {
    const parsed = JSON.parse(res.body);
    return !!parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof parsed.version === 'string';
  } catch {
    return false;
  }
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
