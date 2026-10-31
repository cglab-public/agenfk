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

export interface InjectorRoute { host: string; port: number }
export interface InjectorSecret { placeholder: string; value: string }
/** Where it listens: `port` on the loopback, or `socket` when it was given one. */
export interface KeyInjector { port: number; socket?: string; close(): Promise<void> }

/** At most this many requests at once; past it, 503. */
const MAX_REQUESTS = 64;
/** A request whose upstream says nothing for this long is cut (a stream stays open while it talks). */
const UPSTREAM_IDLE_MS = 10 * 60_000;

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

export async function startKeyInjector(o: KeyInjectorOptions): Promise<KeyInjector> {
  const swap = (v: string) => o.secrets.reduce((acc, s) => acc.split(s.placeholder).join(s.value), v);
  const contexts = new Map<string, tls.SecureContext>();
  const routeOf = (name: string | undefined | null | false) => (name ? o.routes.find((r) => r.host === name.toLowerCase()) : undefined);

  const upstreams = new Set<http.ClientRequest>();
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
  const forward = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const route = routeOf((req.socket as tls.TLSSocket).servername);
    if (!route) { res.writeHead(421).end(); return; }
    if (upstreams.size >= MAX_REQUESTS) { res.writeHead(503).end(); return; }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_HEADERS.includes(k) || v === undefined) continue;
      headers[k] = KEY_HEADERS.includes(k) && typeof v === 'string' ? swap(v) : v;
    }
    headers.host = route.port === 443 ? route.host : `${route.host}:${route.port}`;
    // A key passed as the `key` query parameter (Gemini's style).
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.searchParams.get('key');
    let pathAndQuery = req.url ?? '/';
    if (key !== null && swap(key) !== key) {
      url.searchParams.set('key', swap(key));
      pathAndQuery = url.pathname + url.search;
    }
    const address = allowed.get(req.socket);
    const target = o.connectUpstream?.(route.host, route.port, address) ?? upstreamTarget(route, address);
    const send = target.protocol === 'https:' ? https.request : http.request;
    const up = send({ hostname: target.hostname, port: target.port, method: req.method, path: pathAndQuery, headers, ...(target.protocol === 'https:' ? { servername: target.servername ?? route.host, ...(o.upstreamCa ? { ca: o.upstreamCa } : {}) } : {}) }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    upstreams.add(up);
    up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy());
    up.on('close', () => upstreams.delete(up));
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    // The guest gone, its request upstream goes too: nothing runs (or bills) on for nobody.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.on('error', () => up.destroy());
    req.pipe(up);
  };

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
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
