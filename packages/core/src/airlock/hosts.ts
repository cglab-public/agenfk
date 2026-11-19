/**
 * Host matching: exact names, `*.suffix` wildcards (subdomains only), `*`, and
 * IPv4/IPv6 addresses and CIDR ranges. Addresses are compared as bytes, so
 * `fd00:ec2:0::254` is `fd00:ec2::254` and `::ffff:10.0.0.1` is `10.0.0.1`.
 */
import { isIPv4, isIPv6 } from 'node:net';
import type { HostPattern } from './types';

interface Ip {
  v: 4 | 6;
  bytes: number[];
}

/** Lowercase, no brackets, no trailing dot, no IPv6 zone. */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0 && h.includes(':')) h = h.slice(0, zone);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function ipv6Bytes(addr: string): number[] {
  let s = addr;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, null];
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest ? rest.split(':') : [];
  const fill = rest === null ? 0 : 8 - headGroups.length - restGroups.length;
  const groups = [...headGroups, ...Array(fill).fill('0'), ...restGroups];
  return groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [(v >> 8) & 0xff, v & 0xff];
  });
}

export function parseIp(raw: string): Ip | null {
  const h = normalizeHost(raw);
  if (isIPv4(h)) return { v: 4, bytes: h.split('.').map(Number) };
  if (!isIPv6(h)) return null;
  const bytes = ipv6Bytes(h);
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? { v: 4, bytes: bytes.slice(12) } : { v: 6, bytes };
}

interface Cidr extends Ip {
  prefix: number;
}

export function parseCidr(pattern: string): Cidr | null {
  const slash = pattern.lastIndexOf('/');
  if (slash < 0) return null;
  const addr = pattern.slice(0, slash);
  const bits = pattern.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits)) return null;
  let prefix = Number(bits);
  const written = normalizeHost(addr);
  const ip = parseIp(written);
  if (!ip) return null;
  const writtenAsV6 = isIPv6(written);
  if (prefix > (writtenAsV6 ? 128 : 32)) return null;
  if (writtenAsV6 && ip.v === 4) {
    // ::ffff:a.b.c.d/n — an IPv4 range spelled in IPv6
    if (prefix < 96) return null;
    prefix -= 96;
  }
  return { ...ip, prefix };
}

function prefixEqual(a: number[], b: number[], prefix: number): boolean {
  let left = prefix;
  for (let i = 0; i < a.length && left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

export function isHostname(h: string): boolean {
  return h.length > 0 && h.length <= 253 && HOSTNAME.test(h);
}

/** Is this a pattern the matcher understands? */
export function isValidHostPattern(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const p = normalizeHost(raw);
  if (p === '*') return true;
  if (p.includes('/')) return parseCidr(p) !== null;
  if (parseIp(p)) return true;
  if (p.startsWith('*.')) return isHostname(p.slice(2));
  return isHostname(p);
}

function patternMatches(host: string, ip: Ip | null, rawPattern: string): boolean {
  const p = normalizeHost(rawPattern);
  if (p === '*') return true;
  if (p.includes('/')) {
    const cidr = parseCidr(p);
    return !!cidr && !!ip && ip.v === cidr.v && prefixEqual(ip.bytes, cidr.bytes, cidr.prefix);
  }
  const pip = parseIp(p);
  if (pip) return !!ip && ip.v === pip.v && prefixEqual(ip.bytes, pip.bytes, pip.bytes.length * 8);
  if (ip) return false;
  if (p.startsWith('*.')) return host.length > p.length - 1 && host.endsWith(p.slice(1));
  return host === p;
}

export function matchHost(host: string, patterns: readonly HostPattern[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  const ip = parseIp(h);
  return patterns.some((p) => typeof p === 'string' && patternMatches(h, ip, p));
}

/**
 * The host a URL reaches, as the WHATWG parser resolves it — so numeric and hex
 * spellings (`http://2852039166/`) come out as the dotted address.
 */
export function hostFromUrl(url: string): string | null {
  try {
    const h = normalizeHost(new URL(url).hostname);
    return h || null;
  } catch {
    return null;
  }
}

/**
 * The host in a bare network target: `host`, `user@host`, `host:port/path`,
 * `[v6]:port`, or a bare IPv6 address. Null for anything that does not look
 * like a host. A single word (`evil`) counts only when the caller knows the
 * argument names a host (`known`), since in general it is as likely a file.
 */
export function hostFromTarget(raw: string, known = false): string | null {
  let t = raw.trim();
  if (!t) return null;
  if (t.includes('://')) return hostFromUrl(t);
  const at = t.lastIndexOf('@');
  if (at >= 0) t = t.slice(at + 1);
  if (isIPv6(normalizeHost(t))) t = `[${normalizeHost(t)}]`;
  const m = /^(\[[0-9a-fA-F:.%]+\]|[^:/?#\[\]]+)(?::\d*)?(?:[/?#].*)?$/.exec(t);
  if (!m) return null;
  const candidate = m[1];
  // `2852039166`, `0xA9FEA9FE`, `0251.0376.0251.0376`, `169.254.43518` all dial an IPv4
  // address; let the WHATWG parser (as inet_aton would) spell it out before judging it.
  if (/^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){0,3}$/i.test(candidate)) {
    const ip = hostFromUrl(`http://${candidate}/`);
    return ip && isIPv4(ip) ? ip : null;
  }
  const named = /[a-z]/i.test(candidate) && /^[a-z0-9.-]+$/i.test(candidate);
  const looksLikeHost =
    candidate.startsWith('[') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(candidate) ||
    (named && (known || at >= 0 || candidate.includes('.') || candidate.toLowerCase() === 'localhost'));
  if (!looksLikeHost) return null;
  return hostFromUrl(`http://${candidate}/`);
}
