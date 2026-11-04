/**
 * Airlock on smolvm (CGLAB-696): the model key never enters the machine.
 *
 * The guest is given a placeholder in the key's env var. Its connections to the
 * inference host are redirected by the machine's decider (reply 2, egress.ts) to
 * this injector, in the launcher: it terminates TLS with a certificate issued by
 * the machine's own CA (the guest trusts it beside the host's), puts the real key
 * where the placeholder is - auth headers and a `key` query parameter only, never
 * the body or another header a server might echo back - and sends the request on
 * to the real host, by the route's name whatever Host the guest wrote.
 *
 * smolvm's own credential substitution cannot be used: it is refused with
 * mediated egress. Certificates are built with node-forge, keys with native crypto.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { Duplex } from 'stream';
import tls from 'tls';
import { INJECT_PREFACE } from './egress';

/** The parts of node-forge used here (it ships no types). */
interface ForgeCert {
  publicKey: unknown;
  serialNumber: string;
  validity: { notBefore: Date; notAfter: Date };
  setSubject(attrs: Array<{ name: string; value: string }>): void;
  setIssuer(attrs: unknown): void;
  setExtensions(exts: Array<Record<string, unknown>>): void;
  sign(key: unknown, md: unknown): void;
  subject: { attributes: unknown };
}
interface Forge {
  pki: {
    createCertificate(): ForgeCert;
    publicKeyFromPem(pem: string): unknown;
    privateKeyFromPem(pem: string): unknown;
    certificateFromPem(pem: string): ForgeCert;
    certificateToPem(cert: ForgeCert): string;
  };
  md: { sha256: { create(): unknown } };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge = require('node-forge') as Forge;

export interface MachineCa { certPem: string; keyPem: string }

const DAY = 24 * 60 * 60 * 1000;

function rsaKeys(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
  };
}

/** A positive serial, random. */
const serial = () => `01${crypto.randomBytes(15).toString('hex')}`;

/** The machine's CA, made once in `dir` and kept there (its key readable by the user only). */
/** Whether `certPem` is the certificate of `keyPem`. */
function pairs(certPem: string, keyPem: string): boolean {
  try {
    return new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/**
 * The machine's CA, made once in `dir` and kept there (its key readable by the user only). A
 * certificate that is not its key's is made again. Call it holding the machine's lock: two
 * launchers making one at once would each write their own.
 */
export function machineCa(dir: string): MachineCa {
  const certFile = path.join(dir, 'ca.pem');
  const keyFile = path.join(dir, 'ca.key');
  try {
    const ca = { certPem: fs.readFileSync(certFile, 'utf8'), keyPem: fs.readFileSync(keyFile, 'utf8') };
    if (pairs(ca.certPem, ca.keyPem)) return ca;
  } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = rsaKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const subject = [{ name: 'commonName', value: 'AgEnFK Airlock machine CA' }, { name: 'organizationName', value: 'AgEnFK' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privatePem), forge.md.sha256.create());
  const ca = { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
  // Each file whole: never half a key, never a certificate beside another key for long.
  fs.writeFileSync(`${keyFile}.tmp`, ca.keyPem, { mode: 0o600 });
  fs.chmodSync(`${keyFile}.tmp`, 0o600);
  fs.writeFileSync(`${certFile}.tmp`, ca.certPem, { mode: 0o644 });
  fs.renameSync(`${keyFile}.tmp`, keyFile);
  fs.renameSync(`${certFile}.tmp`, certFile);
  return ca;
}

/** A certificate for `host`, issued by the machine's CA. */
export function leafFor(ca: MachineCa, host: string): { key: string; cert: string } {
  const keys = rsaKeys();
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 30 * DAY);
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }] },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  return { key: keys.privatePem, cert: forge.pki.certificateToPem(cert) };
}

/** A stand-in for a key in the guest's env: random, and saying nothing of the key. */
export function placeholderFor(_name: string): string {
  return `airlock_${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * What the host answers itself on a route, in place of its upstream (b3a0992f: codex's token refresh on
 * auth.openai.com): the request's method, path and body in, the reply out. Nothing goes upstream.
 */
export type LocalAnswer = (req: { method: string; path: string; body: Buffer }) => Promise<{ status: number; body: string; contentType?: string }>;
export interface InjectorRoute { host: string; port: number; answer?: LocalAnswer }
/**
 * A placeholder and what goes where it is: a key the host holds (`value`), or a token from the
 * host's TokenSource (`token`, GH-356) - asked for per request, invalidated and asked for once more
 * when the upstream answers 401.
 */
export type InjectorSecret =
  | { placeholder: string; value: string }
  | { placeholder: string; token: { get(): Promise<string>; invalidate(stale: string): Promise<void> } };
/** Where it listens: `port` on the loopback, or `socket` when it was given one. */
export interface KeyInjector { port: number; socket?: string; close(): Promise<void> }

/** At most this many requests at once; past it, 503. */
const MAX_REQUESTS = 64;
/** A request carrying a token is held whole, to be sent again after a 401: at most this much. */
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
/** And all the requests held at once, together (review): the guest cannot fill the launcher's memory. */
const MAX_HELD_BYTES = 128 * 1024 * 1024;
/** A request whose upstream says nothing for this long is cut (a stream stays open while it talks). */
const UPSTREAM_IDLE_MS = 10 * 60_000;
/** The most of a request the host reads to answer it itself (a token refresh is a few hundred bytes). */
const MAX_ANSWER_BYTES = 64 * 1024;

/** Where a key may be sent: the headers APIs read one from. Nothing else carries it. */
const KEY_HEADERS = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];
/** Not forwarded: they describe the guest's connection to the injector. */
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade'];

export interface UpstreamTarget { protocol: 'http:' | 'https:'; hostname: string; port: number; servername?: string }

/**
 * Where a route's requests go: the address the decider allowed the flow to, over TLS whose
 * certificate is checked for the route's host name - never the name looked up again, which could
 * resolve to an address the policy denies by then (story review 2). Without one, the name.
 */
export function upstreamTarget(route: InjectorRoute, address: string | undefined): UpstreamTarget {
  return { protocol: 'https:', hostname: address ?? route.host, servername: route.host, port: route.port };
}

export interface KeyInjectorOptions {
  ca: MachineCa;
  routes: InjectorRoute[];
  secrets: InjectorSecret[];
  /** Where a route's requests go (`address`: the one the decider allowed); upstreamTarget by default. */
  connectUpstream?: (host: string, port: number, address: string | undefined) => UpstreamTarget;
  /**
   * A Unix socket to listen on (a session's route), instead of a loopback port. There every
   * connection is a flow the decider hands on: INJECT_PREFACE and the address it allowed come
   * first, or the connection is refused.
   */
  socketPath?: string;
  /** Roots the upstream's certificate is checked against instead of the system's (tests). */
  upstreamCa?: string;
  /** How long a flow on the socket may take to finish its TLS handshake (ms). */
  handshakeTimeoutMs?: number;
}

/** The most a preface can be: the marker, an IPv6 address, the newline. */
const MAX_PREFACE = INJECT_PREFACE.length + 46;

const swapWith = (values: Map<string, string>) => (v: string) => [...values].reduce((acc, [ph, real]) => acc.split(ph).join(real), v);

/** The values a request carries where a placeholder may be: its key headers and a `key` query parameter (Gemini's style). */
function carriedBy(req: http.IncomingMessage): string[] {
  const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key');
  return [...Object.entries(req.headers).filter(([k, v]) => KEY_HEADERS.includes(k) && typeof v === 'string').map(([, v]) => v as string), ...(key !== null ? [key] : [])];
}

/**
 * The request as it goes upstream, with these values where their placeholders are. A WebSocket
 * handshake keeps its Connection and Upgrade, which say what it asks for.
 */
function outgoing(req: http.IncomingMessage, route: InjectorRoute, values: Map<string, string>, upgrade = false): { headers: http.OutgoingHttpHeaders; pathAndQuery: string } {
  const swap = swapWith(values);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || (HOP_HEADERS.includes(k) && !(upgrade && (k === 'connection' || k === 'upgrade')))) continue;
    headers[k] = KEY_HEADERS.includes(k) && typeof v === 'string' ? swap(v) : v;
  }
  headers.host = route.port === 443 ? route.host : `${route.host}:${route.port}`;
  let pathAndQuery = req.url ?? '/';
  const url = new URL(pathAndQuery, 'http://x');
  const key = url.searchParams.get('key');
  if (key !== null && swap(key) !== key) {
    url.searchParams.set('key', swap(key));
    pathAndQuery = url.pathname + url.search;
  }
  return { headers, pathAndQuery };
}

/** What the guest is told when the TokenSource could not give its login. */
/**
 * Its code only (b3a0992f review): a source's own message may carry a token - the stale one it was
 * asked to drop - and the guest is never given it. The launcher's log is where diagnostics go.
 */
export function loginRefusal(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const why = code === 'not_connected' || code === 'at_limit' || code === 'revoked' ? code : 'unavailable';
  return `[agenfk airlock] the host could not give this session's login (${why}).`;
}

/** A response's head as it goes back on a raw socket: its status line and the headers it came with. */
function rawHead(status: number, message: string, rawHeaders: string[]): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export async function startKeyInjector(o: KeyInjectorOptions): Promise<KeyInjector> {
  const keys = new Map(o.secrets.flatMap((s) => ('value' in s ? [[s.placeholder, s.value] as [string, string]] : [])));
  const tokens = o.secrets.flatMap((s) => ('token' in s ? [s] : []));
  const contexts = new Map<string, tls.SecureContext>();
  const routeOf = (name: string | undefined | null | false) => (name ? o.routes.find((r) => r.host === name.toLowerCase()) : undefined);

  const upstreams = new Set<http.ClientRequest>();
  /** Token requests, from admission until their answer ends (held, waiting, upstream, retried): counted here, not in upstreams. */
  let waiting = 0;
  let heldBytes = 0;
  const proxy = http.createServer((req, res) => {
    try {
      forward(req, res);
    } catch {
      // Whatever the guest sent (a request target URL cannot read), never the launcher's crash.
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  /** The address the decider allowed each flow on the socket to. */
  const allowed = new WeakMap<net.Socket, string>();
  /** The tokens whose stand-ins a request carries. */
  const usedBy = (req: http.IncomingMessage) => {
    const carried = carriedBy(req);
    return tokens.filter((t) => carried.some((v) => v.includes(t.placeholder)));
  };
  /** The keys, and each used token as the source gives it now. */
  const valuesNow = async (used: typeof tokens) => {
    const values = new Map(keys);
    for (const t of used) values.set(t.placeholder, await t.token.get());
    return values;
  };
  /** A request to the route's upstream, at the address the decider allowed its flow to. */
  const upstreamRequest = (req: http.IncomingMessage, route: InjectorRoute, headers: http.OutgoingHttpHeaders, pathAndQuery: string, onResponse?: (upRes: http.IncomingMessage) => void) => {
    const address = allowed.get(req.socket);
    const target = o.connectUpstream?.(route.host, route.port, address) ?? upstreamTarget(route, address);
    const request = target.protocol === 'https:' ? https.request : http.request;
    return request({ hostname: target.hostname, port: target.port, method: req.method, path: pathAndQuery, headers, ...(target.protocol === 'https:' ? { servername: target.servername ?? route.host, ...(o.upstreamCa ? { ca: o.upstreamCa } : {}) } : {}) }, onResponse);
  };

  /** b3a0992f: a route the host answers itself. Its body is read whole (bounded); nothing goes upstream. */
  const answerHere = (answer: LocalAnswer, req: http.IncomingMessage, res: http.ServerResponse) => {
    // Its slot is released once the reply has ended AND the answer has settled (review): a guest that
    // leaves while the source is asked cannot pile up the source's work past the budget.
    waiting++;
    let holds = 2;
    const drop = () => { if (--holds === 0) waiting--; };
    res.on('close', drop);
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_ANSWER_BYTES) {
            // Cut once the refusal is out, not before: the guest reads why.
            res.once('finish', () => req.destroy());
            res.writeHead(413, { connection: 'close' }).end();
            return;
          }
          chunks.push(c as Buffer);
        }
        const r = await answer({ method: req.method ?? 'GET', path: req.url ?? '/', body: Buffer.concat(chunks) });
        if (!res.destroyed) res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/json' }).end(r.body);
      } catch {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
    })().finally(drop);
  };

  const forward = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const route = routeOf((req.socket as tls.TLSSocket).servername);
    if (!route) { res.writeHead(421).end(); return; }
    if (upstreams.size + waiting >= MAX_REQUESTS) { res.writeHead(503).end(); return; }
    if (route.answer) { answerHere(route.answer, req, res); return; }
    const send = (values: Map<string, string>, onResponse: (upRes: http.IncomingMessage) => void, counted = true): http.ClientRequest => {
      const { headers, pathAndQuery } = outgoing(req, route, values);
      const up = upstreamRequest(req, route, headers, pathAndQuery, onResponse);
      if (counted) {
        upstreams.add(up);
        up.on('close', () => upstreams.delete(up));
      }
      up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy());
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      // The guest gone, its request upstream goes too: nothing runs (or bills) on for nobody.
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      return up;
    };
    const relay = (upRes: http.IncomingMessage) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    };
    const used = usedBy(req);
    if (!used.length) {
      const up = send(keys, relay);
      req.on('error', () => up.destroy());
      req.pipe(up);
      return;
    }
    // GH-356: a token the host holds. The request is held whole, so it can go again after a 401. Its
    // slot is taken now (review), and nothing goes upstream once the guest has gone.
    // Its slot and its held body are released once, when its answer to the guest has ended (review): the
    // body stays held for a retry until then.
    let gone = false;
    waiting++;
    let size = 0;
    let released = false;
    const release = () => { if (released) return; released = true; waiting--; heldBytes -= size; size = 0; };
    // Released when the answer has ended AND no work still holds the body (a token being asked for, a
    // retry): a guest that leaves mid-ask cannot free the budget while its body is still held (review).
    let holds = 1;
    const drop = () => { if (--holds === 0) release(); };
    res.on('close', () => { if (!res.writableFinished) gone = true; drop(); });
    // Whatever fails in the work (a token Node refuses in a header), a 502, never an unhandled rejection (review).
    const holding = <T>(work: () => Promise<T>): Promise<T | void> => {
      holds++;
      return work().catch((e) => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'content-type': 'text/plain' }).end(loginRefusal(e));
      }).finally(drop);
    };
    void holding(async () => {
      const chunks: Buffer[] = [];
      try {
        for await (const c of req) {
          size += (c as Buffer).length;
          heldBytes += (c as Buffer).length;
          if (size > MAX_REPLAY_BYTES || heldBytes > MAX_HELD_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(c as Buffer);
        }
      } catch { res.destroy(); return; }
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      const refuse = (e: unknown) => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'content-type': 'text/plain' }).end(loginRefusal(e));
      };
      let values: Map<string, string>;
      try { values = await valuesNow(used); } catch (e) { refuse(e); return; }
      if (gone) return;
      send(values, (upRes) => {
        if (upRes.statusCode !== 401) { relay(upRes); return; }
        // Invalidated, asked for once more, the same request sent again; its answer is the answer.
        upRes.on('error', () => undefined);
        upRes.resume();
        void holding(async () => {
          try {
            for (const t of used) await t.token.invalidate(values.get(t.placeholder)!);
            values = await valuesNow(used);
          } catch (e) { refuse(e); return; }
          if (gone) return;
          send(values, relay, false).end(body);
        });
      }, false).end(body);
    });
  };

  /** Open WebSocket tunnels' upstream ends, cut when the injector closes. */
  const tunnels = new Set<net.Socket>();
  /**
   * b3a0992f: a WebSocket upgrade (codex opens one to chatgpt.com before HTTPS). Its handshake gets the
   * same swap as a request; a 401 on it invalidates the tokens it used and tries once more. Once
   * switched, the frames go both ways untouched: a placeholder is only ever swapped in the handshake.
   * Its slot is held until the guest's end closes.
   */
  const upgrade = (req: http.IncomingMessage, guest: net.Socket, head: Buffer) => {
    guest.on('error', () => undefined);
    const refuse = (status: number, text = '') => {
      if (guest.destroyed) return;
      guest.end(`${rawHead(status, http.STATUS_CODES[status] ?? '', ['content-type', 'text/plain', 'content-length', String(Buffer.byteLength(text)), 'connection', 'close'])}${text}`);
    };
    const route = routeOf((req.socket as tls.TLSSocket).servername);
    if (!route) { refuse(421); return; }
    if (route.answer) { refuse(403); return; }
    if (upstreams.size + waiting >= MAX_REQUESTS) { refuse(503); return; }
    // Its slot is released once the guest has gone AND no work still runs for it (review): a guest that
    // leaves while its token is being asked for cannot free the budget early, as on the request path.
    waiting++;
    let holds = 1;
    let released = false;
    const drop = () => { if (--holds === 0 && !released) { released = true; waiting--; } };
    guest.once('close', drop);
    const holding = async (work: () => Promise<void>) => {
      holds++;
      try { await work(); } catch (e) {
        // Whatever fails here (a token Node refuses in a header), never an unhandled rejection (review).
        refuse(502, loginRefusal(e));
      } finally { drop(); }
    };
    const used = usedBy(req);
    const attempt = async (retried: boolean): Promise<void> => {
      let values: Map<string, string>;
      try { values = await valuesNow(used); } catch (e) {
        refuse(502, loginRefusal(e));
        return;
      }
      if (guest.destroyed) return;
      const { headers, pathAndQuery } = outgoing(req, route, values, true);
      const up = upstreamRequest(req, route, headers, pathAndQuery);
      let answered = false;
      up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy());
      up.on('error', () => { if (!answered) refuse(502); else guest.destroy(); });
      const cut = () => up.destroy();
      guest.once('close', cut);
      up.on('upgrade', (upRes, upSocket: net.Socket, upHead: Buffer) => {
        answered = true;
        guest.off('close', cut);
        upSocket.setTimeout(0);
        tunnels.add(upSocket);
        upSocket.on('error', () => guest.destroy());
        upSocket.on('close', () => { tunnels.delete(upSocket); guest.destroy(); });
        guest.on('close', () => upSocket.destroy());
        guest.write(rawHead(upRes.statusCode ?? 101, upRes.statusMessage ?? 'Switching Protocols', upRes.rawHeaders));
        if (upHead.length) guest.write(upHead);
        if (head.length) upSocket.write(head);
        upSocket.pipe(guest);
        guest.pipe(upSocket);
      });
      up.on('response', (upRes) => {
        answered = true;
        if (upRes.statusCode === 401 && used.length && !retried) {
          // The refused handshake is done with: cut, not drained (review) - its body could run on untracked.
          upRes.on('error', () => undefined);
          guest.off('close', cut);
          up.destroy();
          void holding(async () => {
            if (guest.destroyed) return;
            for (const t of used) await t.token.invalidate(values.get(t.placeholder)!);
            if (guest.destroyed) return;
            await attempt(true);
          });
          return;
        }
        // Not switched: the refusal goes back as it came, its body until the upstream ends it.
        // Its framing is the guest's connection's own now: the body runs until the socket closes.
        const kept: string[] = [];
        for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
          if (!['content-length', 'transfer-encoding', 'connection'].includes(upRes.rawHeaders[i].toLowerCase())) kept.push(upRes.rawHeaders[i], upRes.rawHeaders[i + 1]);
        }
        guest.write(rawHead(upRes.statusCode ?? 502, upRes.statusMessage ?? '', [...kept, 'connection', 'close']));
        upRes.on('error', () => guest.destroy());
        upRes.pipe(guest);
      });
      up.end();
    };
    void holding(() => attempt(false));
  };
  proxy.on('upgrade', (req: http.IncomingMessage, guest: net.Socket, head: Buffer) => {
    try {
      upgrade(req, guest, head);
    } catch {
      // Whatever the guest sent, never the launcher's crash.
      guest.destroy();
    }
  });

  const sockets = new Set<net.Socket>();
  // A certificate only for a host it injects for: any other name fails the handshake.
  const SNICallback = (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    const route = routeOf(name);
    if (!route) { cb(new Error(`not an inference host: ${name}`)); return; }
    let ctx = contexts.get(route.host);
    if (!ctx) {
      const leaf = leafFor(o.ca, route.host);
      ctx = tls.createSecureContext({ minVersion: 'TLSv1.2', key: leaf.key, cert: leaf.cert + o.ca.certPem });
      contexts.set(route.host, ctx);
    }
    cb(null, ctx);
  };
  const serve = (sock: tls.TLSSocket) => { sock.on('error', () => undefined); proxy.emit('connection', sock); };
  // A guest that drops its connection is no error of the injector's.
  const track = (s: net.Socket) => { sockets.add(s); s.on('error', () => undefined); s.on('close', () => sockets.delete(s)); };
  /** A flow the decider hands on: its preface read, then TLS over the rest. */
  const handOn = (raw: net.Socket) => {
    track(raw);
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => raw.destroy(), 5000);
    raw.once('close', () => clearTimeout(timer));
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl < 0) { if (head.length > MAX_PREFACE) raw.destroy(); return; }
      raw.off('data', onData);
      clearTimeout(timer);
      const line = head.subarray(0, nl).toString('latin1');
      const address = line.startsWith(INJECT_PREFACE) ? line.slice(INJECT_PREFACE.length) : '';
      if (!net.isIP(address)) { raw.destroy(); return; }
      // TLS over what follows the preface. Through a stream of its own: a TLSSocket over the
      // socket itself reads its handle, and the bytes already read past the preface would be lost.
      const rest = new Duplex({
        read() { raw.resume(); },
        write(chunk, _enc, cb) { raw.write(chunk, cb); },
        final(cb) { raw.end(); cb(); },
        destroy(err, cb) { raw.destroy(); cb(err); },
      });
      raw.on('data', (c: Buffer) => { if (!rest.push(c)) raw.pause(); });
      raw.on('end', () => rest.push(null));
      raw.on('close', () => rest.destroy());
      rest.push(head.subarray(nl + 1));
      const secure = new tls.TLSSocket(rest as unknown as net.Socket, { isServer: true, ALPNProtocols: ['http/1.1'], SNICallback, secureContext: tls.createSecureContext({ minVersion: 'TLSv1.2' }) });
      allowed.set(secure, address);
      secure.on('error', () => raw.destroy());
      // As tls.createServer's handshakeTimeout: a flow that never finishes its handshake is cut.
      const handshake = setTimeout(() => raw.destroy(), o.handshakeTimeoutMs ?? 120_000);
      raw.once('close', () => clearTimeout(handshake));
      secure.once('secure', () => { clearTimeout(handshake); serve(secure); });
    };
    raw.on('data', onData);
  };
  const server: net.Server = o.socketPath
    ? net.createServer(handOn)
    : (() => {
      const t = tls.createServer({ minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], SNICallback }, serve);
      t.on('connection', track);
      t.on('tlsClientError', () => undefined);
      return t;
    })();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (o.socketPath) server.listen(o.socketPath, () => resolve());
    else server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    ...(o.socketPath ? { socket: o.socketPath } : {}),
    close: async () => {
      // A guest connection cut cancels its request upstream too (res 'close' above).
      for (const s of sockets) s.destroy();
      for (const t of tunnels) t.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
