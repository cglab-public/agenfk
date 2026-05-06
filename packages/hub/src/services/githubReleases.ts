/**
 * Fetches the public agenfk release list from GitHub and caches it in-memory
 * for ~10 minutes. The admin upgrade UI uses this to populate its target-
 * version dropdown.
 *
 * GitHub's unauthenticated API budget is 60 requests/hour per source IP, so
 * caching is mandatory: a single hub instance with several admins poking at
 * the page would otherwise burn the budget quickly.
 *
 * On a network error we fall back to the most recent successful cache (even
 * if expired) so an outage on github.com doesn't break the UI.
 */

const RELEASES_URL = 'https://api.github.com/repos/cglab-public/agenfk/releases?per_page=100';
const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  versions: string[];
  fetchedAt: number;
}

export type ReleaseFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

let cache: CacheEntry | null = null;
let injectedFetcher: ReleaseFetcher | null = null;

/** Test-only reset hook. */
export function __resetAgenfkReleaseCache(): void {
  cache = null;
}

/** Test-only fetcher injection. Pass null to restore the real fetch. */
export function __setReleaseFetcher(fn: ReleaseFetcher | null): void {
  injectedFetcher = fn;
}

function stripLeadingV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

async function fetchReleases(): Promise<string[]> {
  const fetcher: ReleaseFetcher = injectedFetcher ?? (globalThis.fetch as unknown as ReleaseFetcher);
  const r = await fetcher(RELEASES_URL);
  if (!r.ok) throw new Error(`GitHub releases fetch failed: HTTP ${r.status}`);
  const body = await r.json();
  if (!Array.isArray(body)) throw new Error('GitHub releases payload not an array');
  return body
    .filter((rel: any) => rel && !rel.draft && typeof rel.tag_name === 'string' && rel.tag_name.length > 0)
    .map((rel: any) => stripLeadingV(rel.tag_name));
}

export async function getAgenfkReleases(): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.versions;
  }
  try {
    const versions = await fetchReleases();
    cache = { versions, fetchedAt: now };
    return versions;
  } catch (e) {
    // Fall back to the last-good cache (even if expired) so a transient
    // GitHub outage doesn't break the admin UI.
    if (cache) return cache.versions;
    throw e;
  }
}
