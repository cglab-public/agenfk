/**
 * @vitest-environment jsdom
 */
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RegistryPullsPanel } from '../pages/RegistryPullsPanel';
import { api } from '../api';

/**
 * CGLAB-368 — Admin > Flows lists the open pull requests on the org's flow
 * registry. The hub only lists: each title opens the pull request on GitHub in
 * a new tab, where the admin reviews and merges it.
 */

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const REPO = 'acme-corp/agenfk-flows';
const PULLS = {
  repo: REPO, branch: 'release', isPublic: false,
  pulls: [
    { number: 12, title: 'Add flow: Review Heavy Flow', url: `https://github.com/${REPO}/pull/12`, author: 'acme-bot', createdAt: '2026-09-22T10:00:00Z', draft: false, headBranch: 'flow/review-heavy-flow' },
    { number: 11, title: 'Update flow: Lean Flow', url: `https://github.com/${REPO}/pull/11`, author: 'dana', createdAt: '2026-09-21T09:00:00Z', draft: true, headBranch: 'flow/lean-flow' },
  ],
};

const renderPanel = (queries: Record<string, unknown> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, ...queries } } });
  return render(<QueryClientProvider client={qc}><RegistryPullsPanel /></QueryClientProvider>);
};
const PULLS_TRUNC = { ...PULLS, truncated: true, allUrl: `https://github.com/${REPO}/pulls` };

describe('RegistryPullsPanel (CGLAB-368)', () => {
  beforeEach(() => get.mockReset());
  afterEach(() => { cleanup(); get.mockReset(); });

  it('lists each open pull request as a link that opens GitHub in a new tab', async () => {
    get.mockResolvedValue({ data: PULLS });
    renderPanel();
    const rows = await screen.findAllByTestId('registry-pull');
    expect(rows).toHaveLength(2);
    const link = within(rows[0]).getByRole('link', { name: /Add flow: Review Heavy Flow/ });
    expect(link).toHaveAttribute('href', `https://github.com/${REPO}/pull/12`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);
    expect(rows[0]).toHaveTextContent('#12');
    expect(rows[0]).toHaveTextContent('acme-bot');
    expect(get).toHaveBeenCalledWith('/v1/admin/registry/pulls');
  });

  it('marks a draft pull request', async () => {
    get.mockResolvedValue({ data: PULLS });
    renderPanel();
    const rows = await screen.findAllByTestId('registry-pull');
    expect(rows[1]).toHaveTextContent(/draft/i);
    expect(rows[0]).not.toHaveTextContent(/draft/i);
  });

  it('says so when there is nothing to review, naming the repo', async () => {
    get.mockResolvedValue({ data: { ...PULLS, pulls: [] } });
    renderPanel();
    const empty = await screen.findByTestId('registry-pulls-empty');
    expect(empty).toHaveTextContent(REPO);
    expect(screen.queryAllByTestId('registry-pull')).toHaveLength(0);
  });

  it('explains that an org on the public registry has no pull requests of its own to review', async () => {
    get.mockResolvedValue({ data: { repo: 'cglab-public/agenfk-flows', branch: 'main', isPublic: true, pulls: [] } });
    renderPanel();
    const note = await screen.findByTestId('registry-pulls-public');
    expect(note).toHaveTextContent(/public/i);
    expect(screen.queryByTestId('registry-pulls-empty')).toBeNull();
  });

  it('shows a GitHub failure as an error, not as "nothing to review"', async () => {
    // Shaped like an axios failure, as the other hub-ui specs reject.
    get.mockRejectedValue({ response: { status: 502, data: { error: `GitHub returned 401 listing pull requests on ${REPO}` } } });
    renderPanel();
    // The panel retries once (retryDelay 500ms) before showing the failure.
    const err = await screen.findByTestId('registry-pulls-error', {}, { timeout: 3000 });
    expect(err).toHaveTextContent('GitHub returned 401');
    expect(screen.queryByTestId('registry-pulls-empty')).toBeNull();
  });

  it('never renders a link that is not an https://github.com/ address', async () => {
    get.mockResolvedValue({ data: { ...PULLS, pulls: [{ ...PULLS.pulls[0], url: 'javascript:alert(1)' }] } });
    renderPanel();
    const rows = await screen.findAllByTestId('registry-pull');
    expect(within(rows[0]).queryByRole('link')).toBeNull();
    expect(rows[0]).toHaveTextContent('Add flow: Review Heavy Flow');
  });

  it('shows an error instead of crashing when the answer carries no list', async () => {
    // A payload without `pulls` used to throw on `.length` and take the WHOLE
    // Admin > Flows page down with it - a panel must not be able to do that.
    get.mockResolvedValue({ data: [] });
    renderPanel();
    expect(await screen.findByTestId('registry-pulls-error', {}, { timeout: 3000 })).toHaveTextContent(/unexpected/i);
    expect(screen.queryAllByTestId('registry-pull')).toHaveLength(0);
  });

  // ── review round 2 ───────────────────────────────────────────────────────

  it('does not poll GitHub: one request, then only when the admin asks (A1)', async () => {
    // The app's QueryClient refetches every 30s by default. On this panel that
    // spent the ORG token - the one the whole fleet browses with - per open tab.
    get.mockResolvedValue({ data: PULLS });
    renderPanel({ refetchInterval: 200 });
    await screen.findAllByTestId('registry-pull');
    await new Promise((r) => setTimeout(r, 500));
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('says the list is cut off, and links to the full one (A2)', async () => {
    get.mockResolvedValue({ data: PULLS_TRUNC });
    renderPanel();
    const note = await screen.findByTestId('registry-pulls-truncated');
    const link = within(note).getByRole('link');
    expect(link).toHaveAttribute('href', `https://github.com/${REPO}/pulls`);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('marks which pull requests are published flows (A3)', async () => {
    get.mockResolvedValue({ data: { ...PULLS, pulls: [...PULLS.pulls, { ...PULLS.pulls[0], number: 13, title: 'Bump deps', headBranch: 'dependabot/npm' }] } });
    renderPanel();
    const rows = await screen.findAllByTestId('registry-pull');
    expect(within(rows[0]).getByText(/published flow/i)).toBeDefined();
    expect(within(rows[2]).queryByText(/published flow/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /open pull requests/i })).toBeDefined();
  });

  it('skips a malformed entry instead of failing to render', async () => {
    get.mockResolvedValue({ data: { ...PULLS, pulls: [{ number: 1, title: { nope: true }, url: 'https://github.com/x/y/pull/1' }, PULLS.pulls[0]] } });
    renderPanel();
    const rows = await screen.findAllByTestId('registry-pull');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Add flow: Review Heavy Flow');
  });
});
