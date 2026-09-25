import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import { api } from '../api';

// The open pull requests on the org's flow registry (CGLAB-368): what
// installations have published (CGLAB-367) and is waiting for review. The hub
// only lists them; each title opens the pull request on GitHub, where the
// admin reviews and merges it.

interface RegistryPull {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string | null;
  draft: boolean;
  headBranch: string | null;
}

interface RegistryPulls {
  repo: string;
  branch: string;
  isPublic: boolean;
  pulls: RegistryPull[];
  /** GitHub had more than the one page shown. */
  truncated?: boolean;
  allUrl?: string;
}

/** The only links an admin is handed from this list. The server filters too; this is the second line. */
const isGitHubLink = (url: string) => /^https:\/\/github\.com\//.test(url);

const errorText = (e: unknown): string => {
  const data = (e as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : (e as Error)?.message ?? 'Could not list pull requests.';
};

const openedOn = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

/**
 * Read the answer defensively. A payload without a `pulls` array (an older
 * hub, a proxy's page) must become an error in THIS panel - reading `.length`
 * off it used to throw and take the whole Admin > Flows page down.
 */
const asRegistryPulls = (data: unknown): RegistryPulls => {
  const d = data as Partial<RegistryPulls> | null;
  if (!d || typeof d !== 'object' || typeof d.repo !== 'string' || !Array.isArray(d.pulls)) {
    throw new Error('The hub returned an unexpected answer for the registry pull requests.');
  }
  // Items too: one entry with an object for a title would throw while
  // rendering. A malformed entry is skipped, not allowed to break the list.
  const pulls = (d.pulls as unknown[]).filter((p): p is RegistryPull => {
    const x = p as Partial<RegistryPull> | null;
    return !!x && Number.isInteger(x.number) && typeof x.title === 'string' && typeof x.url === 'string';
  });
  return { ...(d as RegistryPulls), pulls };
};

/** Published by the flow editor (CGLAB-367): its branches are `flow/<slug>`. */
const isPublishedFlow = (p: RegistryPull) => typeof p.headBranch === 'string' && p.headBranch.startsWith('flow/');

export function RegistryPullsPanel() {
  const q = useQuery<RegistryPulls>({
    queryKey: ['admin-registry-pulls'],
    queryFn: async () => asRegistryPulls((await api.get('/v1/admin/registry/pulls'))?.data),
    // Every fetch spends the ORG's GitHub token - the one the whole fleet
    // browses the registry with - so this list never polls: it loads once and
    // refreshes when the admin asks. (The app-wide default refetches every 30s.)
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    retry: 1,
    retryDelay: 500,
  });

  return (
    <section
      className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-4 space-y-3"
      data-testid="admin-registry-pulls"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-ink uppercase tracking-wide">Open pull requests on the flow registry</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Including the flows your installations publish, marked below. Review and merge them on GitHub.
          </p>
        </div>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="shrink-0 px-2 py-1 rounded-lg bg-chip border border-border-soft text-xs text-ink disabled:opacity-50"
        >
          {q.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {q.isLoading && <p className="text-xs text-ink-tertiary">Loading…</p>}

      {q.isError && (
        <p data-testid="registry-pulls-error" className="text-xs text-red-600 dark:text-red-400">
          {errorText(q.error)}
        </p>
      )}

      {q.data?.isPublic && (
        <p data-testid="registry-pulls-public" className="text-xs text-ink-tertiary">
          This org uses the public community registry, so it has no pull requests of its own to review.
          Point it at your own repository above to review what your installations publish.
        </p>
      )}

      {q.data && !q.data.isPublic && q.data.pulls.length === 0 && (
        <p data-testid="registry-pulls-empty" className="text-xs text-ink-tertiary">
          No open pull requests on <code className="px-1 rounded bg-chip text-ink">{q.data.repo}</code>.
        </p>
      )}

      {q.data && !q.data.isPublic && q.data.pulls.length > 0 && (
        <ul className="divide-y divide-border-soft">
          {q.data.pulls.map((p) => {
            const opened = openedOn(p.createdAt);
            return (
              <li key={p.number} data-testid="registry-pull" className="py-2 flex items-start gap-2 text-xs">
                <GitPullRequest size={14} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {isGitHubLink(p.url) ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ink hover:underline inline-flex items-center gap-1"
                    >
                      {p.title}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="font-medium text-ink">{p.title}</span>
                  )}
                  {isPublishedFlow(p) && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-chip text-[10px] text-ink-tertiary align-middle">
                      published flow
                    </span>
                  )}
                  <div className="text-ink-tertiary">
                    #{p.number}
                    {p.author ? ` · ${p.author}` : ''}
                    {opened ? ` · opened ${opened}` : ''}
                    {p.draft ? ' · draft' : ''}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {q.data && !q.data.isPublic && q.data.truncated && (
        <p data-testid="registry-pulls-truncated" className="text-xs text-ink-tertiary">
          Showing the first {q.data.pulls.length} open pull requests.{' '}
          <a
            href={q.data.allUrl && isGitHubLink(q.data.allUrl) ? q.data.allUrl : `https://github.com/${q.data.repo}/pulls`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            See all on GitHub
          </a>
        </p>
      )}
    </section>
  );
}
