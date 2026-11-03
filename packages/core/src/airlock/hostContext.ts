/**
 * What a person sees next to a learned host, to decide on it (user decisions
 * 2026-11-02): the projects whose sessions reached it, an address's reverse
 * DNS name, a model-written sentence when the import asked for one, and exact
 * labels worked out from the name or address alone. Display only: nothing
 * here allows, denies or excludes a host.
 *
 * A context crosses two trust boundaries - the CLI to the server, the
 * installation to the hub - so whoever receives one cleans it here first:
 * only these four fields, bounded, one line each, and any field the
 * receiver's secret screen catches dropped.
 */
import type { AirlockHostContext, AirlockHostLabel } from './learnTypes';
import type { AirlockHostScreen } from './learn';

/** Projects one host's context names. */
export const MAX_CONTEXT_PROJECTS = 10;
export const MAX_PROJECT_CHARS = 64;
/** A hint is a sentence, not a report. */
export const MAX_HINT_CHARS = 300;
export const MAX_HINT_BY_CHARS = 64;

const CONTROL = /[\u0000-\u001f\u007f]/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The public DNS resolvers, by address and by name: a host an agent asks names of, never one it fetches from. */
const PUBLIC_RESOLVERS: ReadonlySet<string> = new Set([
  '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', '1.1.1.3', '1.0.0.3', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112',
  '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15',
  '2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888', '2001:4860:4860::8844', '2620:fe::fe', '2620:fe::9',
  'dns.google', 'one.one.one.one', 'cloudflare-dns.com', 'dns.quad9.net', 'dns.adguard-dns.com',
]);

/**
 * Names cloud providers give the machines they rent out by the hour: the
 * address belongs to someone else once the machine is gone.
 */
const CLOUD_MACHINE_NAMES: readonly RegExp[] = [
  /^ec2-[\d-]+\.(?:[a-z0-9-]+\.)?compute(?:-1)?\.amazonaws\.com(?:\.cn)?$/,
  /\.bc\.googleusercontent\.com$/,
  /\.cloudapp\.azure\.com$/,
  /\.cloudapp\.net$/,
  /\.linodeusercontent\.com$/,
  /\.vultrusercontent\.com$/,
  /^static\.[\d.]+\.clients\.your-server\.de$/,
];

/** Each label as a person reads it (the board and the hub UI keep their own copy: they do not import core). */
export const AIRLOCK_HOST_LABEL_TEXT: Readonly<Record<AirlockHostLabel, string>> = Object.freeze({
  'public-dns-resolver': 'public DNS resolver',
  'cloud-machine': 'cloud machine: the address is someone else\'s once it is gone',
  'network-address': 'network address: more likely a range or a version number than a machine',
  'unnamed-address': 'address with no name',
});

/** Is a learned host an IP address rather than a name? (Learned hosts are canonical.) */
export const isAddressHost = (host: string): boolean => IPV4.test(host) || host.includes(':');

/** What can be said of a host for certain, from its name or address and its reverse DNS name. */
export function hostLabels(host: string, context?: AirlockHostContext | null): AirlockHostLabel[] {
  const name = context?.reverseDns ?? null;
  if (PUBLIC_RESOLVERS.has(host)) return ['public-dns-resolver'];
  const labels: AirlockHostLabel[] = [];
  if ([host, name].some((n) => n && CLOUD_MACHINE_NAMES.some((re) => re.test(n)))) labels.push('cloud-machine');
  // x.y.z.0 names a network more often than a machine: a range or a version string the learner read as an address.
  if (IPV4.exec(host)?.[4] === '0') labels.push('network-address');
  if (isAddressHost(host) && !name) labels.push('unnamed-address');
  return labels;
}

const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A context as it may be kept: its four fields, cleaned and bounded, with any
 * field `screen` says carries a secret dropped. Null when nothing is left, or
 * when it is not an object at all.
 */
export function sanitizeHostContext(raw: unknown, screen?: AirlockHostScreen): AirlockHostContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const clean = (s: string | null): string | null => (s && !(screen && screen(s)) ? s : null);
  const projects: string[] = [];
  if (Array.isArray(r.projects)) {
    for (const p of r.projects) {
      if (typeof p !== 'string' || CONTROL.test(p)) continue;
      const v = clean(p.trim());
      if (!v || v.length > MAX_PROJECT_CHARS || projects.includes(v)) continue;
      projects.push(v);
      if (projects.length === MAX_CONTEXT_PROJECTS) break;
    }
  }
  // Screened as given, before it is lowercased or cut: secret formats are case-sensitive, and a cut can hide a token's tail.
  const rawDns = typeof r.reverseDns === 'string' && !(screen && screen(r.reverseDns)) ? r.reverseDns : '';
  const dns = rawDns.trim().toLowerCase().replace(/\.$/, '');
  const reverseDns = clean(DNS_NAME.test(dns) ? dns : null);
  // One line (case and length kept) is what is judged; a raw multi-line hint reads as changed to the log redaction.
  const fullHint = typeof r.hint === 'string' ? oneLine(r.hint) : '';
  const hint = clean(fullHint && !(screen && screen(fullHint)) ? fullHint.slice(0, MAX_HINT_CHARS).trim() || null : null);
  const by = typeof r.hintBy === 'string' ? oneLine(r.hintBy) : '';
  // Who wrote a hint is only said beside the hint.
  const hintBy = hint ? clean(by && by.length <= MAX_HINT_BY_CHARS ? by : null) : null;
  if (!projects.length && !reverseDns && !hint) return null;
  return { projects, reverseDns, hint, hintBy };
}

/** A context with nothing in it: what an import that found nothing for a host sends, so a stale one is cleared. */
export const EMPTY_HOST_CONTEXT: Readonly<AirlockHostContext> = Object.freeze({ projects: [], reverseDns: null, hint: null, hintBy: null });

/**
 * A host's context after an import: the import's projects and reverse DNS
 * name replace the earlier ones (an import is a snapshot; an empty context
 * clears them), and its hint replaces the earlier hint only when it brought
 * one - an import run without --hints keeps what an earlier one wrote. No
 * context at all (an import from before contexts) leaves it as it was. Null
 * when nothing is left.
 */
export function mergeHostContext(prev: AirlockHostContext | null | undefined, next: AirlockHostContext | null | undefined): AirlockHostContext | null {
  if (!next) return prev ?? null;
  const keepHint = !next.hint && !!prev?.hint;
  const merged = {
    projects: [...next.projects],
    reverseDns: next.reverseDns,
    hint: keepHint ? prev!.hint : next.hint,
    hintBy: keepHint ? prev!.hintBy : next.hintBy,
  };
  return merged.projects.length || merged.reverseDns || merged.hint ? merged : null;
}
