/**
 * Airlock on smolvm (CGLAB-696): the host side of a machine's network.
 *
 * smolvm hands every outbound TCP flow of the guest to a decider on the host's
 * loopback (mediated egress, protocol v2) and waits for it: 0 allows, 1 refuses.
 * The decider names the flow (TLS server name, HTTP Host, else a name the guest
 * looked up that resolves to its address) and applies the session's network
 * policy. The deny side (built-in metadata hosts, the policy's deny list, IOC
 * hosts, denied address ranges) holds in both modes; enforce allows only the
 * allow list (an entry with a port, only that port); observe allows the rest and
 * records what enforce would have done.
 *
 * In enforce mode smolvm is given the allow list too (allowListArgs): the
 * guest's DNS then answers only allowed names, and a flow to an address no
 * allowed name gave is dropped before the decider (measured, smolvm 1.32.4).
 * Those refusals are smolvm's, read from its audit (auditDecision). Every
 * decision, allow and deny, reaches the session's report.
 *
 * One decider per running machine, in a process of its own (egressMain.ts), so
 * it outlives the session that started the machine; sessions read its
 * decisions from a file (HelperEgressBroker.watch).
 */
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { matchHost } from '@agenfk/core';
import type { SandboxSpec } from './spec';
import type { ProxyDecision } from './runtime';
import type { EgressBroker } from './smolvm';

export const FLOW_MAGIC = 'SMOLMEG2';
/**
 * The machine's gateway (smolvm's default guest link, 100.96.0.0/30; `host.smolvm.internal`). A
 * connection to it reaches the decider and nothing else: the decider relays a session's relay port
 * to the host loopback (reply 2) and refuses every other port.
 */
export const GATEWAY = '100.96.0.1';

/**
 * A service of a launcher a flow may be redirected to: the session's relay to the AgEnFK server
 * (a flow to the gateway on that port), or the key injector (a flow to an inference host). Each
 * listens on a Unix socket in the machine's private routes dir, never a TCP port: a launcher that
 * crashed leaves a dead socket (refused), and no other process can take its place there.
 */
/** What the decider sends a key injector before a flow: this, the address it allowed, a newline. */
export const INJECT_PREFACE = 'AGENFK-DEST ';

export type Route =
  | { kind: 'relay'; port: number; socket: string }
  | { kind: 'inject'; host: string; port: number; socket: string };

/** A route as read back from a file: anything else is no route. */
export function asRoute(v: unknown): Route | null {
  const r = v as Partial<Record<string, unknown>>;
  const port = (p: unknown) => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;
  const socket = typeof r?.socket === 'string' && path.isAbsolute(r.socket) ? r.socket : null;
  if (!socket) return null;
  if (r?.kind === 'relay' && port(r.port)) return { kind: 'relay', port: r.port as number, socket };
  if (r?.kind === 'inject' && typeof r.host === 'string' && asHostname(r.host) === r.host && port(r.port)) {
    return { kind: 'inject', host: r.host, port: r.port as number, socket };
  }
  return null;
}
/** magic, token, machine id, parent id, family, port. */
const FIXED = 8 + 32 + 16 + 16 + 1 + 2;
const MAX_PAYLOAD = 65_535;

export interface Flow {
  token: Buffer;
  machineId: string;
  parentId: string;
  family: 4 | 6;
  port: number;
  ip: string;
  /** The flow's first bytes, as smolvm caught them. */
  payload: Buffer;
}
export type Parsed = { kind: 'more' } | { kind: 'invalid'; reason: string } | { kind: 'flow'; flow: Flow };

function ipv6(b: Buffer): string {
  const groups = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2));
  // The longest run of zero groups (two or more) is written ::.
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len && j - i > 1) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

/** One flow from what smolvm has written so far. */
export function parseFlow(buf: Buffer): Parsed {
  if (buf.length < 8) return { kind: 'more' };
  if (buf.toString('latin1', 0, 8) !== FLOW_MAGIC) return { kind: 'invalid', reason: 'not a protocol v2 flow' };
  if (buf.length < FIXED) return { kind: 'more' };
  const family = buf[8 + 32 + 32];
  if (family !== 4 && family !== 6) return { kind: 'invalid', reason: `address family ${family}` };
  const ipLen = family === 4 ? 4 : 16;
  if (buf.length < FIXED + ipLen + 2) return { kind: 'more' };
  const payloadLen = buf.readUInt16BE(FIXED + ipLen);
  if (buf.length < FIXED + ipLen + 2 + payloadLen) return { kind: 'more' };
  const ipBytes = buf.subarray(FIXED, FIXED + ipLen);
  return {
    kind: 'flow',
    flow: {
      token: buf.subarray(8, 40),
      machineId: buf.subarray(40, 56).toString('hex'),
      parentId: buf.subarray(56, 72).toString('hex'),
      family,
      port: buf.readUInt16BE(73),
      ip: family === 4 ? Array.from(ipBytes).join('.') : ipv6(ipBytes),
      payload: buf.subarray(FIXED + ipLen + 2, FIXED + ipLen + 2 + payloadLen),
    },
  };
}

const HOSTNAME = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;
const asHostname = (raw: string): string | null => {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  return h.length <= 253 && HOSTNAME.test(h) ? h : null;
};

/** The TLS ClientHello's server name, read with every bound checked. */
function tlsServerName(b: Buffer): string | null {
  try {
    if (b.length < 6 || b[0] !== 0x16 || b[5] !== 0x01) return null;
    let p = 9 + 2 + 32; // record header, handshake header, version, random
    p += 1 + b[p]; // session id
    p += 2 + b.readUInt16BE(p); // cipher suites
    p += 1 + b[p]; // compression methods
    const end = p + 2 + b.readUInt16BE(p);
    p += 2;
    if (end > b.length) return null;
    while (p + 4 <= end) {
      const type = b.readUInt16BE(p);
      const len = b.readUInt16BE(p + 2);
      if (type === 0) {
        // server_name list: list length, name type, name length, name.
        const nameLen = b.readUInt16BE(p + 7);
        if (b[p + 6] !== 0 || p + 9 + nameLen > b.length) return null;
        return asHostname(b.toString('latin1', p + 9, p + 9 + nameLen));
      }
      p += 4 + len;
    }
  } catch { /* truncated */ }
  return null;
}

/** What the flow's first bytes name: a TLS server name or an HTTP Host (without its port). Null otherwise. */
export function serverNameOf(payload: Buffer): string | null {
  const tls = tlsServerName(payload);
  if (tls) return tls;
  const m = /^[A-Z]+ \S+ HTTP\/1\.[01]\r\n(?:[^\r\n]*\r\n)*?host:[ \t]*([^\r\n]*)\r\n/i.exec(payload.toString('latin1', 0, 8192));
  if (!m) return null;
  const host = m[1].trim().replace(/:\d+$/, '');
  return asHostname(host);
}

type Network = SandboxSpec['network'];

/** An allow entry's host and port: `host`, `host:port`, `[v6]`, `[v6]:port`. */
function entryOf(entry: string): { host: string; port: number | null } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
  if (!m) return { host: entry, port: null };
  return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : null };
}

const isIp = (h: string) => net.isIP(h) !== 0;

function admits(entry: string, name: string | null, ip: string, port: number): boolean {
  const e = entryOf(entry);
  if (e.port !== null && e.port !== port) return false;
  if (isIp(e.host)) return matchHost(ip, [e.host]);
  if (!name) return false;
  return e.host.startsWith('*.') ? name.endsWith(e.host.slice(1)) && name.length > e.host.length - 1 : name === e.host;
}

/**
 * The decision for one flow. `names` are the names it is known by for sure: names the guest looked
 * up that resolve to its address, a claimed name that does, and port-restricted allowed hosts that
 * do. A deny on any wins. `claimed` is a name the flow claims (TLS, HTTP): when there is one, it is
 * what the flow is for, so it alone can allow it (story review 3) - another name its address is
 * known by would let a CDN address serve a name off the list. A claim that is not among `names`
 * (not confirmed: a CDN answers the host and the guest differently) can allow only when nothing
 * else names the flow, and only by an entry without a port, so it never borrows a port-restricted
 * entry. Without a claim, one allowed name allows (in enforce mode smolvm already holds the
 * address to one of an allowed name).
 */
export function decideFlow(flow: { names: string[]; claimed?: string | null; ip: string; port: number }, network: Network): ProxyDecision {
  const { ip, port } = flow;
  const claim = flow.claimed ?? null;
  const confirmed = !!claim && flow.names.includes(claim);
  // A confirmed claim names the flow first; an unconfirmed one, only when nothing else does.
  const names = !claim ? flow.names : confirmed ? [claim, ...flow.names.filter((n) => n !== claim)] : [...flow.names, claim];
  const denied = names.find((n) => matchHost(n, network.deny));
  if (network.denyResolved.length && matchHost(ip, network.denyResolved)) return { host: names[0] ?? ip, port, decision: 'deny', rule: 'denied-address' };
  if (network.deny.includes('*') || matchHost(ip, network.deny) || denied) {
    return { host: denied ?? names[0] ?? ip, port, decision: 'deny', rule: 'deny-list' };
  }
  const byAddress = network.allow.some((e) => admits(e, null, ip, port)) ? ip : null;
  let allowedAs: string | null;
  let refused: string;
  if (claim) {
    const entries = confirmed ? network.allow : flow.names.length ? [] : network.allow.filter((e) => entryOf(e).port === null);
    allowedAs = entries.some((e) => admits(e, claim, ip, port)) ? claim : byAddress;
    // Judged by the names its address is known by when there are any; by an unconfirmed claim alone, unverified.
    refused = !confirmed && !flow.names.length && network.allow.some((e) => admits(e, claim, ip, port)) ? 'unverified-name' : 'not-on-allow-list';
  } else {
    allowedAs = names.find((n) => network.allow.some((e) => admits(e, n, ip, port))) ?? byAddress;
    refused = names.length ? 'not-on-allow-list' : 'unknown-host';
  }
  const host = allowedAs ?? names[0] ?? ip;
  const rule = allowedAs ? 'allow-list' : refused;
  if (network.mode === 'observe') return { host, port, decision: 'allow', rule: `observe:${rule}` };
  return { host, port, decision: allowedAs ? 'allow' : 'deny', rule };
}

const LOOPBACK = ['127.0.0.0/8', '::1', 'localhost', '*.localhost'];
/** Reaches nothing (TEST-NET-1): keeps an enforce list from being empty, which smolvm reads as every host. */
const NOTHING = '192.0.2.1/32';

/**
 * What `smolvm machine update` is given before the machine starts: the allow list smolvm itself
 * enforces. Observe: an empty list (every name resolves, every flow reaches the decider). Enforce:
 * each allowed name as an exact pattern (`--allow-host` would also admit its subdomains), each
 * allowed address as a single-address CIDR; loopback is the relay's (task 3), not smolvm's.
 */
/**
 * A machine's network policy, as sessions sharing it must agree on it: the spec's, without the
 * loopback entries that name each session's own relay to the AgEnFK server (story review).
 */
export function networkKey(network: Network): string {
  return JSON.stringify({ ...network, allow: network.allow.filter((a) => !matchHost(entryOf(a).host, LOOPBACK)) });
}

export function allowListArgs(network: Network): string[] {
  const args = ['--reset-allow-list'];
  // Every host, said explicitly: smolvm refuses to empty a list a machine had (enforce set one) without it.
  if (network.mode === 'observe') return [...args, '--net'];
  // The gateway, where the decider relays a session to its launcher.
  const entries = new Set<string>([`--allow-cidr\0${GATEWAY}/32`]);
  for (const raw of network.allow) {
    const { host } = entryOf(raw);
    if (matchHost(host, LOOPBACK)) continue;
    if (net.isIPv4(host)) entries.add(`--allow-cidr\0${host}/32`);
    else if (net.isIPv6(host)) entries.add(`--allow-cidr\0${host}/128`);
    else entries.add(`--allow-host-pattern\0${host}`);
  }
  // (Never empty: the gateway entry is always there; an empty list is every host to smolvm.)
  if (!entries.size) entries.add(`--allow-cidr\0${NOTHING}`);
  for (const e of entries) args.push(...e.split('\0'));
  return args;
}

/** At most this many names are kept, and this many lookups run at once: the guest cannot make the host do unbounded work. */
const MAX_NAMES = 2048;
const MAX_LOOKUPS = 16;

type Lookup = { at: number; ips: Set<string> | null; pending: Promise<void> | null };

/**
 * Names resolved here: those the guest looked up (`noteQuestion`), so a flow carrying no name of
 * its own (psql, ssh) is named by the address it goes to; and those a flow claims (`addressesOf`),
 * so a claim is believed only when the name resolves to the flow's address. Best effort: a name
 * whose answers differ between lookups may be missed, and the flow then goes unnamed.
 */
export class DnsNames {
  private readonly asked = new Map<string, Lookup>();
  private readonly claimed = new Map<string, Lookup>();
  private inflight = 0;
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly now: () => number;

  constructor(private readonly resolve: (name: string) => Promise<string[]>, opts: { ttlMs?: number; waitMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.waitMs = opts.waitMs ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Expired entries go; past the cap (both maps together), the oldest of `map` go. */
  private prune(map: Map<string, Lookup>): void {
    const now = this.now();
    for (const m of [this.asked, this.claimed]) for (const [name, e] of m) if (now - e.at > this.ttlMs) m.delete(name);
    while (this.asked.size + this.claimed.size >= MAX_NAMES) {
      const from = map.size ? map : map === this.asked ? this.claimed : this.asked;
      from.delete(from.keys().next().value as string);
    }
  }

  private lookup(map: Map<string, Lookup>, name: string): Lookup | null {
    const seen = map.get(name);
    // One lookup at a time per name; a fresh answer is kept until it expires.
    if (seen && (seen.pending || this.now() - seen.at <= this.ttlMs)) return seen;
    if (this.inflight >= MAX_LOOKUPS) return seen ?? null;
    this.prune(map);
    const entry: Lookup = { at: this.now(), ips: seen?.ips ?? null, pending: null };
    this.inflight++;
    entry.pending = this.resolve(name)
      .then((ips) => { entry.ips = new Set(ips); }, () => undefined)
      .finally(() => { entry.pending = null; this.inflight--; });
    map.delete(name);
    map.set(name, entry);
    return entry;
  }

  noteQuestion(raw: string): void {
    const name = asHostname(raw);
    if (name) this.lookup(this.asked, name);
  }

  private wait(pending: Array<Promise<void> | null>): Promise<unknown> {
    const p = pending.filter((x): x is Promise<void> => !!x);
    return p.length ? Promise.race([Promise.all(p), new Promise((r) => setTimeout(r, this.waitMs))]) : Promise.resolve();
  }

  private matching(ip: string): string[] {
    const now = this.now();
    return [...this.asked].filter(([, e]) => now - e.at <= this.ttlMs && e.ips?.has(ip)).map(([n]) => n);
  }

  /** Every name the guest looked up that resolves to `ip`. */
  async namesOf(ip: string): Promise<string[]> {
    const hit = this.matching(ip);
    if (hit.length) return hit;
    await this.wait([...this.asked.values()].map((e) => e.pending));
    return this.matching(ip);
  }

  /** Whether `name` resolves to `ip` here. */
  async resolvesTo(name: string, ip: string): Promise<boolean> {
    const entry = this.lookup(this.claimed, name);
    if (!entry) return false;
    if (entry.pending) await this.wait([entry.pending]);
    return !!entry.ips?.has(ip);
  }

  /** How many names are held (for the bound's test). */
  get size(): number {
    return this.asked.size + this.claimed.size;
  }
}

/** `host:port`, `to host:port` or `[v6]:port` as smolvm's audit writes a destination. */
function destinationOf(raw: string): { host: string; port: number | null } | null {
  const m = /^(?:to )?(\[[^\]]+\]|[^\s:]+)(?::(\d+))?$/.exec(raw.trim());
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : null } : null;
}

/**
 * A refusal smolvm made itself (its allow list), from one line of its audit; null for anything
 * else (the decider reports its own decisions; allowed lookups are not decisions).
 */
export function auditDecision(line: string): ProxyDecision | null {
  let e: { transport?: string; action?: string; destination?: string; reason?: string };
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.action !== 'deny' || e.reason === 'broker_decision' || typeof e.destination !== 'string') return null;
  if (e.transport === 'dns') {
    const name = asHostname(e.destination);
    return name ? { host: name, port: null, decision: 'deny', rule: 'not-on-allow-list' } : null;
  }
  const d = destinationOf(e.destination);
  if (!d) return null;
  if (e.transport === 'tcp') return { ...d, decision: 'deny', rule: 'not-on-allow-list' };
  if (e.transport === 'udp') return { ...d, decision: 'deny', rule: 'udp-refused' };
  return null;
}

/** The whole lines appended to a file since the last read; starts from the file's end as it is now. */
export class LineTail {
  private offset = 0;
  private rest = '';

  constructor(private readonly file: string | null) {
    try { this.offset = file ? fs.statSync(file).size : 0; } catch { this.offset = 0; }
  }

  read(): string[] {
    if (!this.file) return [];
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { return []; }
    // Truncated or replaced: read it from the start.
    if (size < this.offset) { this.offset = 0; this.rest = ''; }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.rest + buf.toString('utf8')).split('\n');
      this.rest = lines.pop() ?? '';
      return lines.filter((l) => l.trim());
    } finally {
      fs.closeSync(fd);
    }
  }
}

export interface EgressServiceOptions {
  /** The 64-hex token smolvm sends with every flow. */
  token: string;
  network: Network;
  /** smolvm's audit for the machine, or null. */
  auditPath: string | null;
  /** Told of each decision; whatever it does, or throws, the answer is the same. */
  onDecision: (decision: ProxyDecision) => void;
  /**
   * Records a decision before its flow is answered. A flow whose decision cannot be recorded is
   * refused: nothing is let through unlogged.
   */
  record?: (decision: ProxyDecision) => void;
  resolve?: (name: string) => Promise<string[]>;
  /** The launchers' services a flow may be redirected to, read for each flow. */
  routes?: () => Route[];
  headerTimeoutMs?: number;
  auditPollMs?: number;
}

const resolveAll = async (name: string): Promise<string[]> => (await dns.promises.lookup(name, { all: true })).map((a) => a.address);

/** The decider: a server on the host loopback, plus smolvm's audit followed for names and refusals. */
export class EgressService {
  private readonly token: Buffer;
  private readonly names: DnsNames;
  private server: net.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private audit: LineTail | null = null;
  private readonly sockets = new Set<net.Socket>();

  /** The network it decides by: the machine's policy, which can change while it runs (story review 2). */
  private network: Network;

  /** From now on, flows are decided by `network`. */
  setNetwork(network: Network): void {
    this.network = network;
  }

  constructor(private readonly o: EgressServiceOptions) {
    this.network = o.network;
    this.token = Buffer.from(o.token, 'hex');
    if (this.token.length !== 32) throw new Error('The egress token must be 64 hex digits.');
    this.names = new DnsNames(o.resolve ?? resolveAll);
  }

  private report(d: ProxyDecision): void {
    try { this.o.onDecision(d); } catch { /* the report never decides anything */ }
  }

  /** One of smolvm's own refusals (already made): recorded and reported, best effort. */
  private reportRefusal(d: ProxyDecision): void {
    try { this.o.record?.(d); } catch { /* the refusal stands */ }
    this.report(d);
  }

  /** Reads what smolvm appended to its audit since the last read. */
  private readAudit(): void {
    for (const line of this.audit?.read() ?? []) {
      try {
        const e = JSON.parse(line);
        if (e.transport === 'dns' && e.action === 'allow' && typeof e.destination === 'string') this.names.noteQuestion(e.destination);
      } catch { /* not json: auditDecision skips it too */ }
      const d = auditDecision(line);
      if (d) this.reportRefusal(d);
    }
  }

  /** Could the policy allow a flow by this name (not denied, and named by an allow entry)? */
  private mayAllow(name: string): boolean {
    const n = this.network;
    if (n.deny.includes('*') || matchHost(name, n.deny)) return false;
    return n.allow.some((e) => { const h = entryOf(e).host; return !isIp(h) && matchHost(name, [h]); });
  }

  private async decide(flow: Flow): Promise<ProxyDecision> {
    // The lookup that preceded this flow may not have been read yet.
    this.readAudit();
    const known = await this.names.namesOf(flow.ip);
    // A name the flow claims (TLS, HTTP) is the guest's word: believed only when it resolves to
    // where the flow goes, so it cannot borrow another allowed name's ports.
    const claimed = serverNameOf(flow.payload);
    // Resolving it here is a lookup the guest's own DNS policy never sees (<secret>.attacker.example,
    // story review 3): only a name the policy could allow is resolved.
    const confirmed = !!claimed && (known.includes(claimed) || (this.mayAllow(claimed) && (await this.names.resolvesTo(claimed, flow.ip))));
    const names = confirmed ? [claimed as string, ...known.filter((n) => n !== claimed)] : [...known];
    // A port-restricted allowed host at this address names the flow too, so its ports hold whatever
    // the flow claims.
    for (const e of this.network.allow) {
      const { host, port } = entryOf(e);
      if (port !== null && !isIp(host) && !names.includes(host) && (await this.names.resolvesTo(host, flow.ip))) names.push(host);
    }
    return decideFlow({ names, claimed, ip: flow.ip, port: flow.port }, this.network);
  }

  private handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => sock.destroy(), this.o.headerTimeoutMs ?? 5000);
    this.sockets.add(sock);
    sock.on('error', () => undefined);
    sock.on('close', () => { clearTimeout(timer); this.sockets.delete(sock); });
    sock.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > FIXED + 16 + 2 + MAX_PAYLOAD) { sock.destroy(); return; }
      const r = parseFlow(buf);
      if (r.kind === 'more') return;
      done = true;
      clearTimeout(timer);
      if (r.kind === 'invalid' || !crypto.timingSafeEqual(r.flow.token, this.token)) { sock.destroy(); return; }
      const flow = r.flow;
      const routes = this.o.routes?.() ?? [];
      if (flow.ip === GATEWAY) {
        // The gateway is the launchers' alone: a session's relay port, or nothing.
        const relays = routes.filter((x) => x.kind === 'relay' && x.port === flow.port).map((x) => x.socket);
        if (relays.length) { this.redirect(sock, flow, relays); return; }
        this.answer(sock, { host: GATEWAY, port: flow.port, decision: 'deny', rule: 'host-not-relayed' });
        return;
      }
      this.decide(flow).then((d) => {
        // answer() redirects only what it allows. Every session's injector swaps the machine's
        // placeholders: any live one will do.
        const injectors = routes.filter((x) => x.kind === 'inject' && x.port === flow.port && x.host === d.host).map((x) => x.socket);
        // The injector is told the address this flow was allowed to: it connects there, never by
        // the name again, which could resolve elsewhere by then (story review 2).
        this.answer(sock, d, injectors.length ? () => this.redirect(sock, flow, injectors, Buffer.from(`${INJECT_PREFACE}${flow.ip}\n`)) : undefined);
      }, () => sock.destroy());
    });
  }

  /** Records and reports `d`, then answers it (or, allowed and redirected, hands the flow on). */
  private answer(sock: net.Socket, d: ProxyDecision, redirect?: () => void): void {
    let sent = d;
    try { this.o.record?.(d); } catch { sent = { ...d, decision: 'deny', rule: 'not-recorded' }; }
    this.report(sent);
    if (sent.decision === 'allow' && redirect) redirect();
    else sock.end(Buffer.from([sent.decision === 'allow' ? 0 : 1]));
  }

  /**
   * Reply 2: this connection becomes the guest's stream. It is carried to the first of `sockets`
   * that takes a connection, the flow's first bytes first (smolvm does not send them again). A
   * socket nothing listens on (its launcher gone) is passed over; none left refuses the flow: no 2
   * is sent before a connection is made. `preface` goes first, when there is one.
   */
  private redirect(sock: net.Socket, flow: Flow, sockets: string[], preface?: Buffer): void {
    const [socket, ...rest] = sockets;
    if (!socket) { sock.destroy(); return; }
    if (sock.destroyed) return;
    const up = net.connect(socket);
    let connected = false;
    up.on('error', () => {
      up.destroy();
      if (!connected) { this.redirect(sock, flow, rest, preface); return; }
      sock.destroy();
    });
    up.once('connect', () => {
      connected = true;
      // Tied to the guest only once connected: an attempt that failed leaves nothing on it.
      if (sock.destroyed) { up.destroy(); return; }
      sock.on('error', () => up.destroy());
      sock.on('close', () => up.destroy());
      up.on('close', () => sock.destroy());
      sock.write(Buffer.from([2]));
      if (preface) up.write(preface);
      up.write(flow.payload);
      sock.pipe(up);
      up.pipe(sock);
    });
  }

  /** Starts listening on the loopback; the address smolvm is pointed at. */
  async listen(): Promise<string> {
    // What the audit held before this machine run is not its.
    this.audit = new LineTail(this.o.auditPath);
    this.timer = setInterval(() => { try { this.readAudit(); } catch { /* read again next time */ } }, this.o.auditPollMs ?? 200);
    this.timer.unref?.();
    const server = net.createServer((s) => this.handle(s));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as net.AddressInfo;
    return `127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // smolvm's last refusals, written before it stopped.
    try { this.readAudit(); } catch { /* unreadable: nothing more to report */ }
    const s = this.server;
    this.server = null;
    // Flows still being decided are refused by being cut: close() would otherwise wait for them.
    for (const sock of this.sockets) sock.destroy();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

/** What the decider process is started with (egressMain.ts), in a file only the user can read. */
export interface EgressConfig {
  token: string;
  network: Network;
  auditPath: string | null;
  /** Where decisions are appended, one JSON line each. */
  decisionsPath: string;
  /** Where the decider writes its address once it listens. */
  addressPath: string;
  /** Where sessions put their routes, one JSON file each. */
  routesDir: string;
}

/** Left beside its config by a decider that follows it (followNetwork). */
export const FOLLOWS_MARK = 'follows-network';

/**
 * Keeps the decider's network as its config says (story review 2): the broker rewrites the file
 * whole when the policy changes. A file that cannot be read changes nothing. The stop.
 */
export function followNetwork(configPath: string, service: { setNetwork(n: Network): void }, intervalMs = 500, startedWith?: Network): () => void {
  // What the decider started with, so a change made before the first read is not taken for it.
  let last: string | null = startedWith ? JSON.stringify(startedWith) : null;
  const timer = setInterval(() => {
    let network: string;
    try {
      const n = (JSON.parse(fs.readFileSync(configPath, 'utf8')) as EgressConfig).network;
      if (!n || !Array.isArray(n.allow) || !Array.isArray(n.deny)) return;
      network = JSON.stringify(n);
    } catch { return; }
    if (last !== null && network !== last) service.setNetwork(JSON.parse(network) as Network);
    last = network;
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The routes in `dir`, as sessions wrote them; anything unreadable is no route. */
export function readRoutes(dir: string): Route[] {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { const r = asRoute(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); return r ? [r] : []; } catch { return []; }
  });
}

/** `ps`'s command line for `pid` (macOS and Linux), or null. */
function commandLineOf(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

interface HelperEgressBrokerDeps {
  /** Where each machine's decider keeps its files (`<stateDir>/egress/<machine>`). */
  stateDir: string;
  /** smolvm's audit for the machine. */
  auditPathOf: (machine: string) => Promise<string | null>;
  /** Starts the decider for `configPath`, detached; its pid. */
  startHelper: (machine: string, configPath: string) => Promise<number>;
  pidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** A process's command line, or null when there is none to read. */
  commandLineOf?: (pid: number) => string | null;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Where route sockets' directories are made (the temp dir). */
  socketDir?: string;
}

/**
 * The decider process: the compiled egressMain.js beside this file, run by this Node. Under
 * Electron (the desktop app's bundled exec helper, whose env no longer says so) it is told to run
 * as Node, or it would start the app.
 */
export function startEgressHelper(
  _machine: string,
  configPath: string,
  o: { spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess; electron?: string } = { electron: process.versions.electron },
): Promise<number> {
  const env = o.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
  const args = [path.join(__dirname, 'egressMain.js'), configPath];
  const child = o.spawn
    ? o.spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env })
    : nodeSpawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  if (!child.pid) return Promise.reject(new Error('Airlock could not start its egress decider.'));
  return Promise.resolve(child.pid);
}

/** One decider per running machine, in a process of its own; sessions read its decisions from a file. */
export class HelperEgressBroker implements EgressBroker {
  constructor(private readonly d: HelperEgressBrokerDeps) {}

  private dir(machine: string): string {
    return path.join(this.d.stateDir, 'egress', machine);
  }

  /**
   * Is `pid` this machine's decider? Alive, and started with this machine's config (story review 2):
   * after a crash or a reboot the recorded pid can be anyone's, never to be reused or signalled.
   */
  private isDecider(machine: string, pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || !this.d.pidAlive(pid)) return false;
    const line = (this.d.commandLineOf ?? commandLineOf)(pid);
    return !!line && line.includes(path.join(this.dir(machine), 'config.json'));
  }

  private running(machine: string): { address: string; token: string; network: string } | null {
    try {
      const dir = this.dir(machine);
      const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
      if (!this.isDecider(machine, pid)) return null;
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as EgressConfig;
      return { address: fs.readFileSync(cfg.addressPath, 'utf8').trim(), token: cfg.token, network: networkKey(cfg.network) };
    } catch {
      return null;
    }
  }

  async ensure(machine: string, spec: SandboxSpec): Promise<{ address: string; token: string }> {
    const up = this.running(machine);
    // Only for this policy: one a crash left running (before its machine started) may decide by another.
    if (up && up.network === networkKey(spec.network)) return { address: up.address, token: up.token };
    await this.stop(machine);
    const dir = this.dir(machine);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config: EgressConfig = {
      token: crypto.randomBytes(32).toString('hex'),
      network: spec.network,
      auditPath: await this.d.auditPathOf(machine),
      decisionsPath: path.join(dir, 'decisions.jsonl'),
      addressPath: path.join(dir, 'address'),
      routesDir: path.join(dir, 'routes'),
    };
    fs.mkdirSync(config.routesDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    const pid = await this.d.startHelper(machine, configPath);
    fs.writeFileSync(path.join(dir, 'pid'), String(pid));
    const deadline = Date.now() + (this.d.readyTimeoutMs ?? 10_000);
    for (;;) {
      try {
        const address = fs.readFileSync(config.addressPath, 'utf8').trim();
        if (address) return { address, token: config.token };
      } catch { /* not yet */ }
      if (Date.now() > deadline || !this.d.pidAlive(pid)) {
        await this.stop(machine);
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`Airlock's egress decider for ${machine} did not start, so nothing was launched.`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * A new Unix socket path for a session's route, in a fresh directory of its own that only the
   * user can open. Under the temp dir, not the state dir: a socket path is short (104 bytes on
   * macOS, 108 on Linux), and a long home would put the state dir's past it.
   */
  routeSocket(_machine: string): string {
    const dir = fs.mkdtempSync(path.join(this.d.socketDir ?? os.tmpdir(), 'agenfk-r-'));
    fs.chmodSync(dir, 0o700);
    const p = path.join(dir, 's.sock');
    if (Buffer.byteLength(p) > 100) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`Airlock's route socket path is too long for a Unix socket (${p}), so nothing was launched.`);
    }
    return p;
  }

  /** Adds a session's route for the machine's decider; the returned function takes it away. */
  addRoute(machine: string, route: Route): () => void {
    const dir = path.join(this.dir(machine), 'routes');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(route), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return () => {
      fs.rmSync(file, { force: true });
      // The socket's own directory, made by routeSocket.
      if (path.basename(path.dirname(route.socket)).startsWith('agenfk-r-')) fs.rmSync(path.dirname(route.socket), { recursive: true, force: true });
    };
  }

  watch(machine: string, onDecision: (decision: ProxyDecision) => void, opts: { pollMs?: number } = {}): () => void {
    const tail = new LineTail(path.join(this.dir(machine), 'decisions.jsonl'));
    const read = () => {
      for (const line of tail.read()) {
        let d: ProxyDecision;
        try { d = JSON.parse(line); } catch { continue; }
        if (typeof d?.host === 'string' && (d.decision === 'allow' || d.decision === 'deny')) {
          try { onDecision({ host: d.host, port: d.port ?? null, decision: d.decision, rule: String(d.rule) }); } catch { /* the hook's own */ }
        }
      }
    };
    const timer = setInterval(() => { try { read(); } catch { /* next time */ } }, opts.pollMs ?? 200);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      try { read(); } catch { /* gone */ }
    };
  }

  /**
   * Ends the machine's decider and waits for it, so its last decisions (smolvm's final refusals,
   * read as it closes) are written. Its decisions file is kept for sessions still reading it; the
   * rest goes. The next start begins from a clean directory.
   */
  /**
   * Hands the machine's running decider a changed network (story review 2): its config, rewritten
   * whole, which it follows (followNetwork). Its token and everything else are kept.
   */
  async updateNetwork(machine: string, network: Network): Promise<void> {
    // A decider an older AgEnFK started reads its config once (story review 2): no change reaches it.
    if (!fs.existsSync(path.join(this.dir(machine), FOLLOWS_MARK))) {
      throw Object.assign(new Error('its machine was started by an older AgEnFK, whose egress decider'), { cannotFollow: true });
    }
    const configPath = path.join(this.dir(machine), 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as EgressConfig;
    fs.writeFileSync(`${configPath}.tmp`, JSON.stringify({ ...config, network }), { mode: 0o600 });
    fs.chmodSync(`${configPath}.tmp`, 0o600);
    fs.renameSync(`${configPath}.tmp`, configPath);
  }

  async stop(machine: string): Promise<void> {
    const dir = this.dir(machine);
    let pid = NaN;
    try { pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')); } catch { /* none */ }
    if (this.isDecider(machine, pid)) {
      const gone = async (signal: NodeJS.Signals, ms: number) => {
        this.d.kill(pid, signal);
        const deadline = Date.now() + ms;
        while (this.d.pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        return !this.d.pidAlive(pid);
      };
      if (!(await gone('SIGTERM', this.d.stopTimeoutMs ?? 3000)) && !(await gone('SIGKILL', 1000))) {
        // Its record stays, so the next stop finds it again.
        throw new Error(`Airlock's egress decider for ${machine} (pid ${pid}) did not end.`);
      }
    }
    for (const f of ['pid', 'config.json', 'address', 'routes', FOLLOWS_MARK]) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
}

/** The broker a launch uses: deciders as detached processes, smolvm's audit found through its data dir. */
export function defaultEgressBroker(dataDirOf: (machine: string) => Promise<string | null>): HelperEgressBroker {
  return new HelperEgressBroker({
    stateDir: path.join(os.homedir(), '.agenfk', 'airlock'),
    auditPathOf: async (machine) => {
      const dir = await dataDirOf(machine);
      return dir ? path.join(dir, 'egress-decisions.jsonl') : null;
    },
    startHelper: startEgressHelper,
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    kill: (pid, signal) => { try { process.kill(pid, signal); } catch { /* gone */ } },
  });
}
