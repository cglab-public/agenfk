import { ghHeaders } from './flowRegistry.js';

/**
 * The open pull requests on an org's flow registry (CGLAB-368), for the admin
 * who reviews and merges what installations publish (CGLAB-367). The hub only
 * LISTS them; review and merge happen on GitHub.
 */

const GITHUB_API = 'https://api.github.com';
const GH_TIMEOUT_MS = 15_000;
/** A pull request link the admin may be handed. Anything else is dropped, never rendered. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\//;

export interface RegistryPull {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string | null;
  draft: boolean;
  headBranch: string | null;
}

export async function listRegistryPulls(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  token: string,
): Promise<{ ok: true; pulls: RegistryPull[]; truncated: boolean } | { ok: false; error: string }> {
  const query = `state=open&base=${encodeURIComponent(branch)}&per_page=100`;
  let resp: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    resp = await fetchImpl(`${GITHUB_API}/repos/${repo}/pulls?${query}`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
  } catch (e: any) {
    return { ok: false, error: `could not reach GitHub listing pull requests on ${repo}: ${e?.message ?? e}` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: resp.status === 403 || resp.status === 404
        ? `the org registry token cannot read pull requests on ${repo} (it needs pull-requests: read; GitHub returned ${resp.status})`
        : `GitHub returned ${resp.status} listing pull requests on ${repo}`,
    };
  }
  // One page of 100 is shown. More than that must be SAID, not silently cut:
  // a short list reads as the whole queue.
  const truncated = /rel="next"/.test(resp.headers?.get?.('link') ?? '');
  const list: any = await resp.json().catch(() => null);
  if (!Array.isArray(list)) return { ok: false, error: `GitHub did not return a list of pull requests for ${repo}` };
  const pulls = list
    .filter((p: any) => p && Number.isInteger(p.number)
      && typeof p.html_url === 'string' && GITHUB_PULL_URL.test(p.html_url))
    .map((p: any): RegistryPull => ({
      number: p.number,
      title: typeof p.title === 'string' ? p.title : `#${p.number}`,
      url: p.html_url,
      author: typeof p.user?.login === 'string' ? p.user.login : null,
      createdAt: typeof p.created_at === 'string' ? p.created_at : null,
      draft: p.draft === true,
      headBranch: typeof p.head?.ref === 'string' ? p.head.ref : null,
    }));
  return { ok: true, pulls, truncated };
}
