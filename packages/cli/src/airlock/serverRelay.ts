/**
 * SX-1 (8dd7c7c0): the launcher's relay to the AgEnFK server.
 *
 * The sandbox is given this relay's loopback port and never the server's, and
 * its AGENFK_API_URL points here. So everything a sandbox sends the server comes
 * through the relay, however it travels: plain through the sandbox proxy, or
 * through a CONNECT tunnel or SOCKS, which skip the proxy's request filter
 * (measured on macOS, ASRT 0.0.81). The relay runs in the launcher, outside the
 * sandbox, and marks every request it forwards (sessionMarker in core), after
 * removing any marker header the agent sent; the server reads the mark to know
 * the request came from a sandbox.
 *
 * In enforce mode a request that cannot be marked is refused here, so nothing
 * from the sandbox reaches the server unmarked. A throw refuses too.
 */
import http from 'http';
import https from 'https';
import { AIRLOCK_SESSION_HEADER } from '@agenfk/core';

/** The server's answer to a marker it did not verify: the relay mints again and sends once more (a token just replaced). */
const MARKER_STATUS_HEADER = 'x-agenfk-airlock-marker';
/** The most a request body may be: it is held so it can be sent again (the server's own limit is 50 MB). */
export const RELAY_MAX_BODY_BYTES = 50 * 1024 * 1024;

export interface ServerRelayOptions {
  /** The AgEnFK server, e.g. http://127.0.0.1:3000 */
  target: string;
  /** The marker to send; null when none can be made (no report token). */
  marker: () => string | null;
  /** Enforce mode: a request that cannot be marked is refused. */
  requireMarker: boolean;
}

export interface ServerRelay {
  host: string;
  port: number;
  close(): Promise<void>;
}

// RFC 9110 7.6.1: these concern one connection, not the request.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function refuse(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function markerOf(opts: ServerRelayOptions): string | null {
  try {
    return opts.marker() || null;
  } catch {
    return null;
  }
}

export function startServerRelay(opts: ServerRelayOptions): Promise<ServerRelay> {
  let target: URL;
  try {
    target = new URL(opts.target);
  } catch {
    return Promise.reject(new Error(`The AgEnFK server address ${opts.target} is not a URL.`));
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error(`The AgEnFK server address ${opts.target} is not http or https.`));
  }
  const transport = target.protocol === 'https:' ? https : http;
  // Its own agent, so close() can end every connection it holds to the server.
  const agent = new transport.Agent({ keepAlive: true });
  const outstanding = new Set<http.ClientRequest>();

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, retried: boolean): void => {
    const marker = markerOf(opts);
    if (!marker && opts.requireMarker) {
      return refuse(res, 503, 'Airlock could not mark this request to the AgEnFK server: ~/.agenfk/airlock/report-token is missing (the server creates it when it starts: agenfk restart).');
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === AIRLOCK_SESSION_HEADER) continue;
      headers[name] = value;
    }
    headers.host = target.host;
    headers['content-length'] = String(body.length);
    if (marker) headers[AIRLOCK_SESSION_HEADER] = marker;
    let upstream: http.ClientRequest;
    try {
      upstream = transport.request({ agent, protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers });
    } catch (e) {
      return refuse(res, 502, `Airlock's relay could not reach the AgEnFK server at ${target.origin} (${(e as Error).message}).`);
    }
    outstanding.add(upstream);
    upstream.on('close', () => outstanding.delete(upstream));
    upstream.on('response', (answer) => {
      // A token the server just replaced: mint with the new one and send once more.
      // The answer set aside is drained, and an error on it ends nothing.
      if (!retried && answer.statusCode === 401 && answer.headers[MARKER_STATUS_HEADER] === 'invalid') {
        answer.on('error', () => undefined);
        answer.resume();
        return forward(req, res, body, true);
      }
      const back: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) back[name] = value;
      res.writeHead(answer.statusCode ?? 502, back);
      // A response the server broke off: end the agent's too, so it is not left waiting.
      answer.on('error', () => res.destroy());
      answer.on('close', () => { if (!answer.complete) res.destroy(); });
      answer.pipe(res);
    });
    upstream.on('error', (e) => refuse(res, 502, `Airlock's relay could not reach the AgEnFK server at ${target.origin} (${e.message}).`));
    // The agent went away before the answer finished: stop the server's side too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end(body);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > RELAY_MAX_BODY_BYTES) tooBig = true;
      else chunks.push(d);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (tooBig) return refuse(res, 413, `Airlock's relay takes request bodies up to ${RELAY_MAX_BODY_BYTES} bytes.`);
      forward(req, res, Buffer.concat(chunks), false);
    });
  });
  // A websocket or other upgrade is not something the agenfk clients use: refused.
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\n\r\n'); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        host: '127.0.0.1',
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
          for (const r of outstanding) r.destroy();
          agent.destroy();
        }),
      });
    });
  });
}
