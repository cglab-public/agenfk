/**
 * Airlock host lists as the editors write them (user decision 2026-11-02): one
 * host, *.domain or CIDR per line, and "download" or "upload" after it for an
 * entry that holds one way only; a line with neither is both ways.
 *
 * The lists are encoded as @agenfk/core's hostLists.ts encodes them (the board
 * does not import core): a one-way allow in allowDownload/allowUpload, a one-way
 * block in deny AND in denyUpload/denyDownload, empty one-way lists left out.
 * The server normalises whatever it is sent; this keeps an untouched policy
 * the same so the editor does not read as changed.
 */
export interface AirlockHostListsDto {
  allow: string[];
  deny: string[];
  allowDownload?: string[];
  allowUpload?: string[];
  denyUpload?: string[];
  denyDownload?: string[];
}

type Way = 'download' | 'upload' | 'both';
const WAYS: readonly string[] = ['download', 'upload', 'both'];

/** One line: its pattern, and its direction when the last word names one. */
function entryOf(line: string): { pattern: string; way: Way } {
  const words = line.trim().split(/\s+/);
  const last = words[words.length - 1].toLowerCase();
  if (words.length > 1 && WAYS.includes(last)) return { pattern: words.slice(0, -1).join(' '), way: last as Way };
  return { pattern: words.join(' '), way: 'both' };
}

const entriesOf = (text: string) => text.split('\n').filter(l => l.trim()).map(entryOf);

/** The allow side as lines: both-way entries, then download-only, then upload-only. */
export function allowTextOf(h?: Partial<AirlockHostListsDto>): string {
  return [
    ...(h?.allow ?? []),
    ...(h?.allowDownload ?? []).map(p => `${p} download`),
    ...(h?.allowUpload ?? []).map(p => `${p} upload`),
  ].join('\n');
}

/** The deny side as lines, in deny's order, each one-way block with its direction. */
export function denyTextOf(h?: Partial<AirlockHostListsDto>): string {
  const up = new Set(h?.denyUpload ?? []);
  const down = new Set(h?.denyDownload ?? []);
  return (h?.deny ?? []).map(p => (up.has(p) && !down.has(p) ? `${p} upload` : down.has(p) && !up.has(p) ? `${p} download` : p)).join('\n');
}

/** The two text boxes as host lists. */
export function hostListsOf(allowText: string, denyText: string): AirlockHostListsDto {
  const out: AirlockHostListsDto = { allow: [], deny: [] };
  const allowDownload: string[] = [];
  const allowUpload: string[] = [];
  const denyUpload: string[] = [];
  const denyDownload: string[] = [];
  for (const { pattern, way } of entriesOf(allowText)) (way === 'download' ? allowDownload : way === 'upload' ? allowUpload : out.allow).push(pattern);
  for (const { pattern, way } of entriesOf(denyText)) {
    out.deny.push(pattern);
    if (way === 'upload') denyUpload.push(pattern);
    if (way === 'download') denyDownload.push(pattern);
  }
  if (allowDownload.length) out.allowDownload = allowDownload;
  if (allowUpload.length) out.allowUpload = allowUpload;
  if (denyUpload.length) out.denyUpload = denyUpload;
  if (denyDownload.length) out.denyDownload = denyDownload;
  return out;
}

/** Whether host lists hold anything at all. */
export const hasHostEntries = (h: AirlockHostListsDto): boolean =>
  [h.allow, h.deny, h.allowDownload, h.allowUpload, h.denyUpload, h.denyDownload].some(l => (l?.length ?? 0) > 0);

/** The editors' help for a direction. */
export const DIRECTION_HELP = 'Add “download” or “upload” after it to make an entry one way only.';

/** What can be said of a learned host for certain (core hostLabels), and what an import knew of it. */
export type HostLabelDto = 'public-dns-resolver' | 'cloud-machine' | 'network-address' | 'unnamed-address';
export interface HostContextDto {
  projects: string[];
  reverseDns: string | null;
  /** One sentence a model wrote (agenfk airlock learn --hints): display only. */
  hint: string | null;
  hintBy: string | null;
}

/** Each label as a person reads it: core's AIRLOCK_HOST_LABEL_TEXT, copied (this package does not import core). */
export const HOST_LABEL_TEXT: Readonly<Record<HostLabelDto, string>> = {
  'public-dns-resolver': 'public DNS resolver',
  'cloud-machine': 'cloud machine: the address is someone else\'s once it is gone',
  'network-address': 'network address: more likely a range or a version number than a machine',
  'unnamed-address': 'address with no name',
};

/** A host's facts as one line's parts: its labels, its reverse DNS name and the projects that reached it. */
export function hostFacts(labels?: readonly string[] | null, context?: HostContextDto | null): string[] {
  return [
    ...(labels ?? []).map(l => HOST_LABEL_TEXT[l as HostLabelDto] ?? l),
    ...(context?.reverseDns ? [`reverse DNS ${context.reverseDns}`] : []),
    ...(context?.projects?.length ? [`seen in ${context.projects.join(', ')}`] : []),
  ];
}
