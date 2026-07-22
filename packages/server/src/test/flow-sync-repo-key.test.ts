/**
 * Phase D: the client resolves flows from the hub keyed on the git REPO
 * (remote URL), not the local projectId. reconcileProjectFlow builds the
 * outbound GET /v1/flows/active URL with `?repo=` when a remoteUrl is supplied,
 * falling back to `?projectId=` (legacy) when it isn't.
 */
import { describe, it, expect } from 'vitest';
import { reconcileProjectFlow, type FetchLike } from '../hub/flowSync';

const hubConfig = { url: 'http://hub.example.test', token: 'agk_test', orgId: 'org-test' } as any;

function capturingFetch(urls: string[]): FetchLike {
  return async (url: string) => {
    urls.push(url);
    // 304 short-circuits before any storage access — we only assert the URL.
    return { status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) };
  };
}

describe('reconcileProjectFlow — repo-keyed hub pull', () => {
  it('sends ?repo (encoded) and not ?projectId when a remoteUrl is supplied', async () => {
    const urls: string[] = [];
    await reconcileProjectFlow({
      storage: {} as any,
      hubConfig,
      projectId: 'p-local-uuid',
      remoteUrl: 'git@github.com:acme/web.git',
      lastEtag: 'W/"x"',
      fetchImpl: capturingFetch(urls),
      emit: () => {},
    });
    expect(urls[0]).toContain(`repo=${encodeURIComponent('git@github.com:acme/web.git')}`);
    expect(urls[0]).not.toContain('projectId=');
  });

  it('falls back to ?projectId when no remoteUrl is available (legacy/no-remote project)', async () => {
    const urls: string[] = [];
    await reconcileProjectFlow({
      storage: {} as any,
      hubConfig,
      projectId: 'p-local-uuid',
      remoteUrl: null,
      lastEtag: 'W/"x"',
      fetchImpl: capturingFetch(urls),
      emit: () => {},
    });
    expect(urls[0]).toContain('projectId=p-local-uuid');
    expect(urls[0]).not.toContain('repo=');
  });

  it('org-fallback (no projectId, no remoteUrl) sends the bare endpoint', async () => {
    const urls: string[] = [];
    await reconcileProjectFlow({
      storage: {} as any,
      hubConfig,
      projectId: null,
      remoteUrl: null,
      lastEtag: 'W/"x"',
      fetchImpl: capturingFetch(urls),
      emit: () => {},
    });
    expect(urls[0]).toMatch(/\/v1\/flows\/active$/);
  });
});
