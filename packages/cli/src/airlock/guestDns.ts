/**
 * CGLAB-696 task 8: the resolver Airlock runs inside the machine (user decision 2026-10-30).
 *
 * smolvm cannot refuse a DNS name (its filter only allows), so a lookup of a denied or IOC name
 * would leave the machine - a DNS exfiltration channel, in observe mode for any name. The guest
 * firewall redirects every port-53 question here instead, whichever server it was sent to
 * (smolvm.ts, guestDnsScript): a denied name is answered NXDOMAIN without asking anyone, and every
 * other question goes to smolvm's resolver, its answer passed back as it came.
 *
 * It runs on the image's node from this file alone (`node guestDns.js <config.json>`), so it uses
 * nothing but Node's built-ins. Started as root, it binds - its listener, and the one UDP socket it
 * asks smolvm's resolver from, on a privileged source port only root can bind - then runs as the
 * user the config names. The guest firewall lets port-53 traffic out from that source port alone
 * (the guest kernel has no owner match, measured), so nothing else in the machine can ask smolvm's
 * resolver; TCP questions are asked over that socket too. ACCEPTED LIMIT (review 01a18ddc): an
 * answer too large for UDP comes back truncated to a TCP asker as well - TCP upstream would need a
 * new privileged source port per connection, after the resolver has given up root.
 * Beyond it (review 01a18ddc): DNS over HTTPS or TLS to a host the policy allows carries any
 * question inside an allowed TCP connection, which only the host decider sees, as that host; and
 * a lookup refused here is not reported to the board (smolvm's audit reports what it refuses).
 */
import dgram from 'dgram';
import fs from 'fs';
import net from 'net';

export interface ResolverConfig {
  host: string;
  port: number;
  /** smolvm's resolver: where allowed questions go. */
  upstream: { host: string; port: number };
  /** The source port allowed questions leave from (a privileged one in the guest); a system one when absent. */
  upstreamSourcePort?: number;
  /** Name patterns: exact, `*.domain` (its subdomains), or `*` (every name). */
  deny: string[];
  /** Enforce: the only names answered (same patterns); every name when absent (observe). */
  allow?: string[];
  /** The user (and group) to run as once bound. */
  uid?: number;
  gid?: number;
}

export interface Resolver {
  port: number;
  close(): Promise<void>;
}

const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_TCP_MESSAGE = 65_535;
/** A session's pressure on the resolver is bounded (review 01a18ddc): past these, the connection is cut. */
const MAX_TCP_CONNECTIONS = 64;
const MAX_TCP_IN_FLIGHT = 32;
const MAX_TCP_QUEUED_BYTES = 256 * 1024;

/** The question section of a query (after its 12-byte header), or null. */
function questionOf(msg: Buffer): Buffer | null {
  if (questionName(msg) === null) return null;
  let p = 12;
  while (msg[p] !== 0) p += 1 + msg[p];
  return msg.subarray(12, p + 1 + 4);
}

/**
 * The name a query asks about, lower-cased, without a trailing dot: only for a well-formed query
 * with exactly one question (no compression - a query has none). Null for anything else.
 */
export function questionName(msg: Buffer): string | null {
  if (msg.length < 12 + 5) return null;
  if (msg[2] & 0x80) return null;
  if (msg.readUInt16BE(4) !== 1) return null;
  const labels: string[] = [];
  let p = 12;
  for (;;) {
    if (p >= msg.length) return null;
    const len = msg[p];
    if (len === 0) { p++; break; }
    if (len & 0xc0) return null;
    if (p + 1 + len > msg.length) return null;
    labels.push(msg.toString('latin1', p + 1, p + 1 + len));
    p += 1 + len;
  }
  if (p + 4 > msg.length) return null;
  const name = labels.join('.').toLowerCase();
  return name.length && name.length <= 253 ? name : null;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether `name` is denied: an exact entry, a `*.domain` entry for a subdomain, or `*`. Address entries are not names. */
export function nameDenied(name: string, deny: readonly string[]): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return deny.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/\.$/, '');
    if (p === '*') return true;
    if (!p || IPV4.test(p) || p.includes(':') || p.includes('/')) return false;
    if (p.startsWith('*.')) return n.length > p.length - 1 && n.endsWith(p.slice(1));
    return n === p;
  });
}

/** The query answered NXDOMAIN: its id, its question, no records. Null when there is no question to echo. */
export function refusalOf(query: Buffer): Buffer | null {
  if (questionName(query) === null) return null;
  let p = 12;
  while (query[p] !== 0) p += 1 + query[p];
  const end = p + 1 + 4;
  const out = Buffer.from(query.subarray(0, end));
  // QR, the opcode and RD as asked, RA; rcode 3 (NXDOMAIN).
  out[2] = 0x80 | (query[2] & 0x79);
  out[3] = 0x80 | 3;
  out.writeUInt16BE(1, 4);
  out.writeUInt16BE(0, 6);
  out.writeUInt16BE(0, 8);
  out.writeUInt16BE(0, 10);
  return out;
}

/** SERVFAIL for a question the resolver will not pass on and cannot echo. */
function failureOf(query: Buffer): Buffer | null {
  if (query.length < 12) return null;
  const out = Buffer.alloc(12);
  query.copy(out, 0, 0, 2);
  out[2] = 0x80;
  out[3] = 0x80 | 2;
  return out;
}

/** The answer to `msg`: refused here, failed here, or smolvm's. */
async function answer(msg: Buffer, c: ResolverConfig, ask: (m: Buffer) => Promise<Buffer>): Promise<Buffer | null> {
  const name = questionName(msg);
  if (name === null) return failureOf(msg);
  if (nameDenied(name, c.deny) || (c.allow && !nameDenied(name, c.allow))) return refusalOf(msg);
  try {
    return await ask(msg);
  } catch {
    return failureOf(msg);
  }
}

/** smolvm's resolver, asked over one socket: each question under an id of its own, its answer given the asker's id back. */
class Upstream {
  private readonly pending = new Map<number, { id: number; question: Buffer; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private next = Math.floor(Math.random() * 0x10000);
  constructor(private readonly socket: dgram.Socket, private readonly to: ResolverConfig['upstream']) {
    socket.on('message', (m, from) => {
      if (from.address !== to.host || from.port !== to.port || m.length < 12) return;
      const p = this.pending.get(m.readUInt16BE(0));
      // An answer, to this very question: a late one to an earlier question under a reused id is not it.
      if (!p || !(m[2] & 0x80) || !m.subarray(12, 12 + p.question.length).equals(p.question)) return;
      this.pending.delete(m.readUInt16BE(0));
      clearTimeout(p.timer);
      const answer = Buffer.from(m);
      answer.writeUInt16BE(p.id, 0);
      p.resolve(answer);
    });
  }

  ask(msg: Buffer): Promise<Buffer> {
    if (this.pending.size >= 0xffff) return Promise.reject(new Error('too many questions in flight'));
    let id = this.next;
    while (this.pending.has(id)) id = (id + 1) & 0xffff;
    this.next = (id + 1) & 0xffff;
    const out = Buffer.from(msg);
    out.writeUInt16BE(id, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, UPSTREAM_TIMEOUT_MS);
      this.pending.set(id, { id: msg.readUInt16BE(0), question: Buffer.from(questionOf(msg) ?? Buffer.alloc(0)), resolve, reject, timer });
      this.socket.send(out, this.to.port, this.to.host, (e) => {
        if (!e) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  close(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    this.pending.clear();
    try { this.socket.close(); } catch { /* closed */ }
  }
}

/** Starts the resolver on UDP and TCP at `host:port` (port 0: one of the system's). */
export async function startResolver(c: ResolverConfig): Promise<Resolver> {
  const upSocket = dgram.createSocket(net.isIPv6(c.upstream.host) ? 'udp6' : 'udp4');
  upSocket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { upSocket.once('error', reject); upSocket.bind(c.upstreamSourcePort ?? 0, () => resolve()); });
  const up = new Upstream(upSocket, c.upstream);
  const ask = (m: Buffer) => up.ask(m);
  const udp = dgram.createSocket(net.isIPv6(c.host) ? 'udp6' : 'udp4');
  udp.on('error', () => undefined);
  let closing = false;
  udp.on('message', (msg, from) => {
    void answer(msg, c, ask).then((a) => {
      // Not after close: a question pending then is failed, and its socket is gone.
      if (!a || closing) return;
      try { udp.send(a, from.port, from.address); } catch { /* closed */ }
    });
  });
  await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(c.port, c.host, () => resolve()); });
  const port = udp.address().port;
  const tcp = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    let inFlight = 0;
    s.setTimeout(UPSTREAM_TIMEOUT_MS * 2, () => s.destroy());
    s.on('error', () => undefined);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 2 + MAX_TCP_MESSAGE) { s.destroy(); return; }
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        buf = buf.subarray(2 + msg.length);
        // An asker that does not read its answers, or asks without end, is cut off.
        if (++inFlight > MAX_TCP_IN_FLIGHT || s.writableLength > MAX_TCP_QUEUED_BYTES) { s.destroy(); return; }
        void answer(msg, c, ask).then((a) => {
          inFlight--;
          if (!a || s.destroyed) return;
          const len = Buffer.alloc(2);
          len.writeUInt16BE(a.length);
          s.write(Buffer.concat([len, a]));
          if (s.writableLength > MAX_TCP_QUEUED_BYTES) s.destroy();
        });
      }
    });
  });
  tcp.maxConnections = MAX_TCP_CONNECTIONS;
  await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(port, c.host, () => resolve()); });
  return {
    port,
    close: () => new Promise<void>((resolve) => { closing = true; up.close(); udp.close(); tcp.close(() => resolve()); }),
  };
}

/**
 * Keeps `c`'s lists as its config file says (story review 2): the launcher rewrites it, whole, when
 * the policy changes while sessions run. A file that cannot be read changes nothing. The stop.
 */
export function followConfig(configPath: string, c: ResolverConfig, intervalMs = 1000): () => void {
  let last = '';
  const timer = setInterval(() => {
    let text: string;
    try { text = fs.readFileSync(configPath, 'utf8'); } catch { return; }
    if (text === last) return;
    try {
      const next = JSON.parse(text) as Partial<ResolverConfig>;
      if (!Array.isArray(next.deny) || (next.allow !== undefined && !Array.isArray(next.allow))) return;
      c.deny = next.deny;
      c.allow = next.allow;
      last = text;
    } catch { /* half a file: read again next time */ }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function main(configPath: string): Promise<void> {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ResolverConfig;
  await startResolver(c);
  followConfig(configPath, c);
  // Said while still root, beside its config: it follows it (a running one an older AgEnFK started does not).
  fs.writeFileSync(`${configPath.replace(/[^/]*$/, '')}follows`, '');
  // Bound: now as the resolver's own user, whom alone the firewall lets ask smolvm's resolver.
  if (typeof c.gid === 'number') process.setgid?.(c.gid);
  if (typeof c.uid === 'number') process.setuid?.(c.uid);
  process.stdout.write('ready\n');
}

if (require.main === module) {
  main(process.argv[2]).catch((e) => {
    process.stderr.write(`agenfk guest resolver: ${(e as Error)?.message ?? e}\n`);
    process.exit(1);
  });
}
