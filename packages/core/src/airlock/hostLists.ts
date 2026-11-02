/**
 * Direction per allowed and blocked host (user decision 2026-11-02): every
 * entry is for downloads, uploads or both, and an entry without one is both.
 *
 * Encoded so an installation older than this is never looser than the policy:
 *  - `allow` / `deny`: both ways, as before;
 *  - `allowDownload` / `allowUpload`: one-way allows, in lists an older
 *    installation does not read, so there they allow nothing;
 *  - `denyUpload` / `denyDownload`: one-way blocks, each ALSO in `deny`, so an
 *    older installation blocks them both ways; these lists only narrow.
 *
 * Direction is judged on tool calls (the command says which way data goes).
 * The sandbox network cannot see it: one connection carries both ways and is
 * decided before any data moves, so it reaches a host allowed in some
 * direction and refuses only a host blocked both ways.
 */
import type { AirlockHostLists, HostDirection, HostPattern } from './types';
import { matchHost, normalizeHost, parseCidr } from './hosts';

export type HostEntryDirection = HostDirection | 'both';

/** One row of an editor: a pattern, on the allow or the deny side, for one direction or both. */
export interface HostEntry {
  pattern: HostPattern;
  list: 'allow' | 'deny';
  direction: HostEntryDirection;
}

type Side = Map<HostPattern, Set<HostDirection>>;

const add = (side: Side, pattern: HostPattern, dirs: readonly HostDirection[]): void => {
  const set = side.get(pattern) ?? new Set<HostDirection>();
  for (const d of dirs) set.add(d);
  side.set(pattern, set);
};

const BOTH: readonly HostDirection[] = ['download', 'upload'];

/** Each pattern's directions, per side. Lists are taken as already normalised patterns. */
function decode(lists: Partial<AirlockHostLists>): { allow: Side; deny: Side } {
  const allow: Side = new Map();
  const deny: Side = new Map();
  for (const p of lists.allow ?? []) add(allow, p, BOTH);
  for (const p of lists.allowDownload ?? []) add(allow, p, ['download']);
  for (const p of lists.allowUpload ?? []) add(allow, p, ['upload']);
  const up = new Set(lists.denyUpload ?? []);
  const down = new Set(lists.denyDownload ?? []);
  for (const p of lists.deny ?? []) {
    // A deny entry narrowed to exactly one direction; both narrowings, or none, are both ways.
    add(deny, p, up.has(p) && !down.has(p) ? ['upload'] : down.has(p) && !up.has(p) ? ['download'] : BOTH);
  }
  // A narrowing with no deny entry still blocks (and is written into deny on the way out).
  for (const p of up) if (!deny.has(p)) add(deny, p, down.has(p) ? BOTH : ['upload']);
  for (const p of down) if (!deny.has(p)) add(deny, p, ['download']);
  return { allow, deny };
}

function encode(sides: { allow: Side; deny: Side }): AirlockHostLists {
  const out: AirlockHostLists = { allow: [], deny: [] };
  const allowDownload: HostPattern[] = [];
  const allowUpload: HostPattern[] = [];
  const denyUpload: HostPattern[] = [];
  const denyDownload: HostPattern[] = [];
  for (const [p, dirs] of sides.allow) {
    if (dirs.size === 2) out.allow.push(p);
    else if (dirs.has('download')) allowDownload.push(p);
    else allowUpload.push(p);
  }
  for (const [p, dirs] of sides.deny) {
    out.deny.push(p);
    if (dirs.size === 2) continue;
    if (dirs.has('upload')) denyUpload.push(p);
    else denyDownload.push(p);
  }
  if (allowDownload.length) out.allowDownload = allowDownload;
  if (allowUpload.length) out.allowUpload = allowUpload;
  if (denyUpload.length) out.denyUpload = denyUpload;
  if (denyDownload.length) out.denyDownload = denyDownload;
  return out;
}

/** The lists in their one encoding: a pattern on each side once, with the directions it has. */
export function canonicalHostLists(lists: Partial<AirlockHostLists>): AirlockHostLists {
  return encode(decode(lists));
}

/** Both sets of lists together, per pattern and direction: an addition can widen a block or an allow, never narrow one. */
export function mergeHostLists(a: Partial<AirlockHostLists>, b: Partial<AirlockHostLists>): AirlockHostLists {
  const x = decode(a);
  const y = decode(b);
  for (const [p, dirs] of y.allow) add(x.allow, p, [...dirs]);
  for (const [p, dirs] of y.deny) add(x.deny, p, [...dirs]);
  return encode(x);
}

/** The patterns that allow `dir`. */
export function allowedFor(lists: AirlockHostLists, dir: HostDirection): HostPattern[] {
  return [...lists.allow, ...((dir === 'download' ? lists.allowDownload : lists.allowUpload) ?? [])];
}

/** The patterns that block `dir`: every block except those narrowed to the other direction. */
export function deniedFor(lists: AirlockHostLists, dir: HostDirection): HostPattern[] {
  const other = new Set((dir === 'download' ? lists.denyUpload : lists.denyDownload) ?? []);
  return lists.deny.filter((p) => !other.has(p));
}

/** What the sandbox network may reach: a host allowed in some direction. */
export function networkAllow(lists: AirlockHostLists): HostPattern[] {
  return [...new Set([...lists.allow, ...(lists.allowDownload ?? []), ...(lists.allowUpload ?? [])])];
}

/** Whether every host `q` matches, `p` matches too. */
function covers(p: HostPattern, q: HostPattern): boolean {
  const a = normalizeHost(p);
  const b = normalizeHost(q);
  if (a === '*') return true;
  if (b === '*') return false;
  if (b.includes('/')) {
    const pc = parseCidr(a);
    const qc = parseCidr(b);
    return !!pc && !!qc && pc.prefix <= qc.prefix && matchHost(b.slice(0, b.lastIndexOf('/')), [a]);
  }
  if (b.startsWith('*.')) return a.startsWith('*.') && (b === a || b.endsWith(a.slice(1)));
  return matchHost(b, [a]);
}

/**
 * What the sandbox network refuses: a host blocked both ways - by a both-way
 * entry, or by an upload-only and a download-only entry that overlap (where one
 * covers the other, the narrower is blocked both ways).
 */
export function networkDeny(lists: AirlockHostLists): HostPattern[] {
  const up = lists.denyUpload ?? [];
  const down = lists.denyDownload ?? [];
  const narrowed = new Set([...up, ...down]);
  const out = new Set(lists.deny.filter((p) => !narrowed.has(p)));
  for (const u of up) {
    for (const d of down) {
      if (covers(u, d)) out.add(d);
      else if (covers(d, u)) out.add(u);
    }
  }
  return [...out];
}

/** The lists as editor rows: allows first, then blocks, each in list order. */
export function hostEntries(lists: AirlockHostLists): HostEntry[] {
  const { allow, deny } = decode(lists);
  const row = (list: HostEntry['list']) => ([pattern, dirs]: [HostPattern, Set<HostDirection>]): HostEntry => ({
    pattern, list, direction: dirs.size === 2 ? 'both' : dirs.has('download') ? 'download' : 'upload',
  });
  return [...[...allow].map(row('allow')), ...[...deny].map(row('deny'))];
}

/** Editor rows back to lists. Patterns are taken as given: normalise the policy afterwards. */
export function hostListsFromEntries(entries: readonly HostEntry[]): AirlockHostLists {
  const sides = { allow: new Map() as Side, deny: new Map() as Side };
  for (const e of entries) add(sides[e.list], e.pattern, e.direction === 'both' ? BOTH : [e.direction]);
  return encode(sides);
}
