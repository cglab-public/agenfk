/**
 * A POST to the local AgEnFK server (CGLAB-169).
 *
 * `probes.ts` deliberately only does GET — it exists to identify a server, and
 * a probe that could mutate state would be the wrong shape for that job.
 * Creating a worktree is a POST, so it lives here instead of widening the
 * probe surface.
 *
 * Same wall-clock deadline as httpGet, and for the same reason: Node's
 * `timeout` option measures INACTIVITY, so a server that dribbles bytes
 * forever never trips it. A reviewer reproduced exactly that hang on httpGet
 * (settled=false after 6003ms), which is why the deadline is a real timer
 * rather than a socket option.
 */
import * as http from 'http';
import type { HttpResponse } from './probes.js';

const REQUEST_DEADLINE_MS = 5000;

/**
 * POST by default, and any method the caller names.
 *
 * `PUT` joined because pointing a project at its folder is a PUT behind the
 * internal token — a second copy of this function to change one string would
 * be the duplication this file exists to avoid.
 */
export const httpPost = (
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
  body = '',
  method = 'POST',
): Promise<HttpResponse | null> =>
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

    request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => finish({
          status: res.statusCode ?? 0,
          body: data,
          contentType: String(res.headers['content-type'] ?? ''),
        }));
      },
    );

    request.on('error', () => finish(null));
    request.end(body);
  });
