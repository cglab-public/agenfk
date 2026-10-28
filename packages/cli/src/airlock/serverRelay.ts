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
import { parse as legacyParse } from 'url';
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

/**
 * SX-4 (4d1594b9): what only the board may do. Every board-only (or
 * board-privileged) route trusts `x-agenfk-ui`; the board never comes through the
 * relay and no agenfk client inside the sandbox sends it, so a request carrying
 * it is refused. The routes themselves are refused too, by method and path,
 * whatever the headers say (Express routes case-insensitively and takes a
 * trailing slash, so these do as well).
 */
const BOARD_HEADER = 'x-agenfk-ui';
const BOARD_ONLY: ReadonlyArray<{ method: string | null; path: RegExp }> = [
  { method: 'PUT', path: /^\/airlock\/policy$/ },
  { method: 'POST', path: /^\/airlock\/approvals\/[^/]+\/(?:grant|deny)$/ },
  { method: 'POST', path: /^\/airlock\/learning\/(?:accept|forward)$/ },
  { method: 'POST', path: /^\/items\/[^/]+\/(?:approvals|overrides)$/ },
  { method: 'POST', path: /^\/projects\/[^/]+\/command-approvals$/ },
  { method: null, path: /^\/webauthn(?:\/|$)/ },
  { method: 'PUT', path: /^\/api\/telemetry\/config$/ },
  { method: 'POST', path: /^\/github\/signout$/ },
  { method: 'POST', path: /^\/releases\/update$/ },
  // DS-3: what the Airlock scorer learns from is a person's to import, never a sandbox's -
  // whether or not this relay could mark the request (an observe launch with no token).
  { method: 'POST', path: /^\/airlock\/dataset\/import$/ },
  // BUG 794bb674 (epic review): the host's terminals. herdr's panes take text and keys the
  // server types into shells outside the sandbox, and a terminal session launches an agent
  // on the host; reading them shows other terminals. None of it is the sandbox's, reads included.
  { method: null, path: /^\/herdr(?:\/|$)/ },
  { method: null, path: /^\/terminal-sessions(?:\/|$)/ },
];

/** Why a request from the sandbox must not reach the server, or null. */
export function boardOnlyRefusal(method: string | undefined, url: string | undefined, headers: http.IncomingHttpHeaders): string | null {
  if (headers[BOARD_HEADER] !== undefined) return 'the board\'s header (x-agenfk-ui) never comes from the Airlock sandbox';
  const raw = (url ?? '/').split(/[?#]/)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* judged as spelled */ }
  // As Express's parseurl reads it: Node's legacy parser, which trims and rewrites some characters.
  let legacy = raw;
  try { legacy = legacyParse(url ?? '/').pathname ?? raw; } catch { /* judged as spelled */ }
  // As spelled (Express routes the encoded path, then decodes its parameters), decoded, and as
  // the legacy parser reads it; case and repeated or trailing slashes do not matter to any.
  const forms = [raw, decoded, legacy, legacy.trim()].map((p) => p.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/');
  const m = (method ?? 'GET').toUpperCase();
  const hit = forms.find((p) => BOARD_ONLY.some((r) => (r.method === null || r.method === m) && r.path.test(p)));
  return hit ? `${m} ${hit} is for a person on the board, not the Airlock sandbox` : null;
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
    // Only a path: an absolute-form target (`PUT http://host/...`) or `*` would be
    // routed by the server from a part this relay did not judge.
    // ...and printable ASCII only: a parser on the server side may trim or rewrite anything else.
    if (!req.url || !req.url.startsWith('/') || /[^\x21-\x7e]/.test(req.url)) {
      req.on('end', () => refuse(res, 400, 'Airlock\'s relay takes a request for a path on the AgEnFK server only.'));
      req.on('error', () => res.destroy());
      req.resume();
      return;
    }
    const boardOnly = boardOnlyRefusal(req.method, req.url, req.headers);
    if (boardOnly) {
      // read the body to its end first: answering mid-upload drops the connection
      req.on('end', () => refuse(res, 403, `Airlock refused this request: ${boardOnly}.`));
      req.on('error', () => res.destroy());
      req.resume();
      return;
    }
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
