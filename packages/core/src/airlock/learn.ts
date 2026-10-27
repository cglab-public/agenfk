/**
 * Airlock learning mode (GH-294, TEL-3): a proposed allowlist from the hosts
 * sessions actually reached, for a person to accept. Pure: the server learns
 * and stores, the CLI imports pi session logs, the hub dedupes across
 * installations; all three judge hosts here.
 *
 * Where a host was seen matters, so each row keeps its hits by source:
 *  - 'proxy': the launcher's sandbox proxy reported it, with a token the
 *    sandboxed agent cannot read, so the agent cannot forge it;
 *  - 'tool': a tool call the server judged (POST /airlock/evaluate is loopback
 *    and unauthenticated, so the agent could send anything);
 *  - 'import': a pi session log, which the agent wrote.
 * The proposal names a host's evidence 'proxy' when the proxy saw it and
 * 'agent-reported' otherwise, and ranks proxy evidence first.
 *
 * Nothing here applies anything: accepting is a person's act (user decision
 * 2026-10-27), on the board when standalone and on the hub when joined.
 */
import { analyseCommand } from './shell';
import { capabilitiesOf } from './capabilities';
import { hostFromUrl, isHostname, matchHost, normalizeHost, parseIp } from './hosts';
import { normalizeAirlockPolicy } from './policy';
import { BUILTIN_DENY_HOSTS, type AirlockPolicy, type Capability } from './types';
import type {
  AirlockHostObservation, AirlockImportTally, AirlockLearnedHost, AirlockLearningEvidence, AirlockLearningExclusion,
  AirlockLearnSource, AirlockProposal, AirlockProposedHost,
} from './learnTypes';

export type {
  AirlockHostObservation, AirlockImportTally, AirlockLearnedHost, AirlockLearningEvidence, AirlockLearningExclusion,
  AirlockLearnSource, AirlockProposal, AirlockProposedHost,
} from './learnTypes';

export const AIRLOCK_LEARN_SOURCES: readonly AirlockLearnSource[] = ['tool', 'proxy', 'import'];

/** Clients and cards kept per host: enough to say who reached it, bounded. */
export const MAX_LEARNED_CLIENTS = 10;
export const MAX_LEARNED_CARDS = 20;
/** Hosts a proposal lists (and excluded hosts it names). */
export const AIRLOCK_PROPOSAL_LIMIT = 500;

/**
 * Loopback, private, shared, link-local and unspecified addresses, and the
 * names that only ever mean this machine or its link. Never proposed: an
 * allowlist entry for one would open the sandbox onto the local network.
 */
export const PRIVATE_HOST_PATTERNS: readonly string[] = Object.freeze([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10',
  'localhost', '*.localhost', '*.local',
]);

/** Dotted parts that are each decimal, octal or hex: a spelling inet_aton reads as an IPv4 address. */
const NUMERIC_HOST = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){0,3}$/i;

/**
 * The host as it is learned, or null when it is not one: a DNS name with at
 * least one dot (or `localhost`, so it can be named as excluded), or an IP
 * address. Never a pattern, a URL, a path, a port or a query.
 *
 * A numeric spelling the evaluator reads as an address (`0x7f.0.0.1`,
 * `2852039166`, `1.2.3`) is learned as that address, canonical, so the
 * metadata and private-address exclusions see what would really be dialled.
 */
export function learnableHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let h = normalizeHost(raw);
  if (!h) return null;
  if (NUMERIC_HOST.test(h)) {
    // As the WHATWG parser (and so the evaluator) spells it out; not an address at all: not a host.
    const ip = hostFromUrl(`http://${h}/`);
    if (!ip || !parseIp(ip) || ip.includes(':')) return null;
    h = ip;
  } else if (/(?:^|\.)(?:\d+|0x[0-9a-f]*)$/i.test(h)) {
    // Ends in a number but is no address: the URL parser refuses it as a host, and so does this.
    return null;
  }
  const ip = parseIp(h);
  if (ip) return /[/%]/.test(h) ? null : h;
  if (!isHostname(h)) return null;
  return h.includes('.') || h === 'localhost' ? h : null;
}

const uniq = (list: Iterable<string>): string[] => [...new Set(list)];

/**
 * Says whether a host, AS IT WAS WRITTEN, carries a secret (true: do not keep
 * it). Given by the caller (the server and the CLI pass the shared log
 * redaction), so this engine stays free of it.
 */
export type AirlockHostScreen = (spelling: string) => boolean;

/** Any non-ASCII character: a call, a proxy host or an import entry holding one teaches no host. */
const NON_ASCII = /[^\x00-\x7f]/;

/** ASCII-only lowercasing: a non-ASCII letter must not fold into a host. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The raw host tokens of a text, exactly as written: for each word holding a
 * URL, its authority (between `//` and the first `/ ? #`) without userinfo
 * or port; for any other word, what precedes the first `: / ? #` after any
 * `user@`. Words split where the shell would; a query string or any other
 * part of a word is never a token.
 */
export function rawHostTokens(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.split(/[\s'"`;|&()<>]+/)) {
    if (!word) continue;
    const scheme = word.indexOf('://');
    let t = scheme >= 0 ? word.slice(scheme + 3) : word;
    if (scheme >= 0) t = t.split(/[/?#]/, 1)[0];
    const at = t.lastIndexOf('@');
    if (at >= 0) t = t.slice(at + 1);
    if (t.startsWith('[')) t = t.slice(0, t.indexOf(']') + 1) || t;
    else t = t.split(/[:/?#]/, 1)[0];
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * The host one raw token is learned as, or null. The raw token is ALWAYS
 * screened first, as written - a numeric spelling too (`0xdeadbeef` can hold
 * an env secret before it becomes an address). Then it must BE the host up to
 * ASCII case (and the brackets or trailing dot normalising drops), unless the
 * difference is only a numeric-address conversion: a name any other
 * normalising reached (an IDN or full-width dot, a non-ASCII letter that
 * folds to ASCII) is refused, since what the screen saw is not what would be kept.
 */
export function learnRawHost(raw: string, screen?: AirlockHostScreen): string | null {
  if (NON_ASCII.test(raw) || (screen && screen(raw))) return null;
  const host = learnableHost(raw);
  // The learned form too: a secret can match only once lowercased.
  if (!host || (screen && screen(host))) return null;
  const written = asciiLower(raw.trim()).replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (written === host || (NUMERIC_HOST.test(written) && parseIp(host))) return host;
  return null;
}

/**
 * The hosts one tool call reaches: commands through the shell parser, URLs
 * through the URL parser. Each must come from a raw token of the call's own
 * text (rawHostTokens) that learnRawHost accepts: with a screen, a token
 * carrying a secret as written keeps its host out, and a host no raw token
 * spells is not learned.
 */
export function hostsOfCapabilities(caps: readonly Capability[], screen?: AirlockHostScreen): string[] {
  // Fail closed: a call with any non-ASCII anywhere teaches nothing.
  if (caps.some((c) => NON_ASCII.test(c.kind === 'command' ? c.command : c.kind === 'url' ? c.url : c.path))) return [];
  const out: string[] = [];
  for (const c of caps) {
    const text = c.kind === 'command' ? c.command : c.kind === 'url' ? c.url : '';
    const found = c.kind === 'command' ? analyseCommand(c.command).hosts : c.kind === 'url' ? [hostFromUrl(c.url)] : [];
    const wanted = new Set(found.map(learnableHost).filter((h): h is string => h !== null));
    if (!wanted.size) continue;
    // Every raw token that canonicalises to a wanted host; one refused (a
    // secret, or a spelling only normalising reached) keeps that host out.
    const accepted = new Set<string>();
    const refused = new Set<string>();
    for (const raw of rawHostTokens(text)) {
      const canonical = learnableHost(raw);
      if (!canonical || !wanted.has(canonical)) continue;
      if (learnRawHost(raw, screen) === canonical) accepted.add(canonical);
      else refused.add(canonical);
    }
    for (const h of wanted) if (accepted.has(h) && !refused.has(h)) out.push(h);
  }
  return uniq(out);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The hosts the tool calls of one pi session record reach: an assistant
 * message's `toolCall` parts, read by their arguments (command, url, and a
 * fetch tool's `urls`), each call's hosts once. Any other record - the user's
 * text, a tool's result, a model change - yields nothing.
 */
export function hostsOfPiRecord(record: unknown, screen?: AirlockHostScreen): string[] {
  if (!isObject(record) || record.type !== 'message' || !isObject(record.message)) return [];
  const message = record.message;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const part of message.content) {
    if (!isObject(part) || part.type !== 'toolCall' || !isObject(part.arguments)) continue;
    const args = part.arguments;
    if (NON_ASCII.test(JSON.stringify(args))) continue;
    const caps = capabilitiesOf(args);
    if (Array.isArray(args.urls)) {
      for (const u of args.urls) if (typeof u === 'string' && u.trim()) caps.push({ kind: 'url', url: u });
    }
    out.push(...hostsOfCapabilities(caps, screen));
  }
  return out;
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

const earlier = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a < b ? a : b);
const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

/**
 * The largest serialised import request the CLI sends: headroom under the
 * server's 256kb body limit on /airlock (AIRLOCK_BODY_LIMIT, routes.ts; a
 * server test holds the two together).
 */
export const AIRLOCK_IMPORT_MAX_BYTES = 192 * 1024;

/** Distinct hosts one import tallies; past it a new host is dropped and counted. */
export const MAX_IMPORT_HOSTS = 10_000;

export interface AirlockTallyOptions {
  screen?: AirlockHostScreen;
  /** Distinct hosts the tally may hold (default MAX_IMPORT_HOSTS). */
  maxHosts?: number;
  /** Counts what was left out: sightings of hosts past the cap. */
  stats?: { droppedHosts: number };
}

/**
 * Count one line of a pi session log into `tally`. Returns how many tool-call
 * host sightings it counted; a line that is not JSON counts nothing. A new
 * host past `maxHosts` is not added (counted in `stats.droppedHosts`).
 */
export function tallyPiSessionLine(line: string, tally: Map<string, AirlockImportTally>, opts: AirlockTallyOptions = {}): number {
  if (!line || line[0] !== '{') return 0;
  let record: unknown;
  try { record = JSON.parse(line); } catch { return 0; }
  const hosts = hostsOfPiRecord(record, opts.screen);
  const at = isObject(record) ? isoOrNull(record.timestamp) : null;
  const max = opts.maxHosts ?? MAX_IMPORT_HOSTS;
  let counted = 0;
  for (const host of hosts) {
    if (!tally.has(host) && tally.size >= max) {
      if (opts.stats) opts.stats.droppedHosts++;
      continue;
    }
    counted++;
    const t = tally.get(host) ?? { hits: 0, firstSeen: null, lastSeen: null };
    t.hits++;
    t.firstSeen = earlier(t.firstSeen, at);
    t.lastSeen = later(t.lastSeen, at);
    tally.set(host, t);
  }
  return counted;
}

const addBounded = (list: string[], value: string | null | undefined, max: number): string[] =>
  !value || list.includes(value) || list.length >= max ? list : [...list, value];

/** How far back a reported sighting may be dated; an older date is read as this. */
export const MAX_SIGHTING_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** A reported time, clamped to [receivedAt - MAX_SIGHTING_AGE_MS, receivedAt]; unreadable is receivedAt. */
export function clampSighting(v: unknown, receivedAt: string): string {
  const now = Date.parse(receivedAt);
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return receivedAt;
  return new Date(Math.min(now, Math.max(now - MAX_SIGHTING_AGE_MS, t))).toISOString();
}

/**
 * A host's row with one observation merged in. A sighting adds its hits; an
 * import REPLACES the imported count, since an import is a snapshot of the
 * logs, so importing them again does not double it. The window only widens.
 *
 * Times a caller reports (ts, firstSeen) are only shown, and clamped to the
 * receipt time: never in the future, never before MAX_SIGHTING_AGE_MS.
 * receivedAt - the server's own clock - is what retention and eviction use,
 * so an invented date cannot keep a row forever.
 */
export function mergeHostObservation(row: AirlockLearnedHost | null, o: AirlockHostObservation): AirlockLearnedHost {
  const receivedAt = isoOrNull(o.receivedAt) ?? new Date().toISOString();
  const seen = clampSighting(o.ts, receivedAt);
  const first = o.source === 'import' && o.firstSeen ? clampSighting(o.firstSeen, receivedAt) : seen;
  const n = Number.isInteger(o.hits) && (o.hits as number) > 0 ? (o.hits as number) : 1;
  const base: AirlockLearnedHost = row ?? {
    host: o.host, hits: { tool: 0, proxy: 0, import: 0 }, firstSeen: first, lastSeen: seen, receivedAt, clients: [], cards: [],
  };
  const hits = { ...base.hits };
  hits[o.source] = o.source === 'import' ? n : hits[o.source] + n;
  return {
    host: base.host,
    hits,
    firstSeen: earlier(base.firstSeen, first) as string,
    lastSeen: later(base.lastSeen, seen) as string,
    receivedAt: later(base.receivedAt ?? null, receivedAt) as string,
    clients: addBounded(base.clients, o.client, MAX_LEARNED_CLIENTS),
    cards: addBounded(base.cards, o.itemId, MAX_LEARNED_CARDS),
  };
}

/** Why a host is never proposed against `policy`, or null when it may be. */
export function learningExclusionOf(host: string, policy: AirlockPolicy): AirlockLearningExclusion | null {
  if (matchHost(host, BUILTIN_DENY_HOSTS)) return 'metadata-endpoint';
  if (matchHost(host, policy.iocHosts.hosts)) return 'ioc-host';
  if (matchHost(host, policy.hosts.deny)) return 'denied-host';
  if (matchHost(host, policy.hosts.allow)) return 'already-allowed';
  if (matchHost(host, PRIVATE_HOST_PATTERNS)) return 'private-address';
  return null;
}

/** What a learned host's evidence is: the proxy's word, or only the agent's. */
export const evidenceOf = (hits: Record<AirlockLearnSource, number>): AirlockLearningEvidence =>
  hits.proxy > 0 ? 'proxy' : 'agent-reported';

/**
 * The proposed allowlist: every learned host that is a host and that no
 * exclusion covers, proxy evidence first, then by hits, then by name.
 */
export function proposeAllowlist(
  learned: readonly AirlockLearnedHost[], policy: AirlockPolicy, opts: { limit?: number } = {},
): AirlockProposal {
  const limit = Math.max(1, Math.floor(opts.limit ?? AIRLOCK_PROPOSAL_LIMIT));
  const hosts: AirlockProposedHost[] = [];
  const excluded: AirlockProposal['excluded'] = [];
  for (const row of learned) {
    const host = learnableHost(row.host);
    if (!host || host !== row.host) continue;
    const reason = learningExclusionOf(host, policy);
    if (reason) {
      excluded.push({ host, reason });
      continue;
    }
    const sources = { tool: row.hits.tool ?? 0, proxy: row.hits.proxy ?? 0, import: row.hits.import ?? 0 };
    hosts.push({
      host,
      hits: sources.tool + sources.proxy + sources.import,
      sources,
      evidence: evidenceOf(sources),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      clients: [...row.clients],
      cards: [...row.cards],
    });
  }
  hosts.sort((a, b) =>
    (a.evidence === b.evidence ? 0 : a.evidence === 'proxy' ? -1 : 1) || b.hits - a.hits || a.host.localeCompare(b.host));
  excluded.sort((a, b) => a.host.localeCompare(b.host));
  return { hosts: hosts.slice(0, limit), excluded: excluded.slice(0, limit) };
}

/** `policy` with `hosts` added to its allow list, everything else as it was. */
export function withAcceptedHosts(policy: AirlockPolicy, hosts: readonly string[]): AirlockPolicy {
  return normalizeAirlockPolicy({ ...policy, hosts: { ...policy.hosts, allow: [...policy.hosts.allow, ...hosts] } });
}
