/**
 * @vitest-environment jsdom
 *
 * 4aac7076 (CGLAB-164): What's New shows the INSTALLED release's notes.
 *
 * Clicking the version chip on 2.0.0-beta.12 showed 1.1.20's notes: the modal
 * read the latest-stable feed. It now reads /releases/current - the installed
 * version's own release - and says so when that version has none.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WhatsNewModal } from '../components/WhatsNewModal';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getCurrentRelease: vi.fn(),
    getLatestRelease: vi.fn(),
  },
}));

const LATEST_STABLE = {
  version: '1.1.20', tagName: 'v1.1.20', name: 'v1.1.20', body: 'Notes for the latest stable',
  publishedAt: '2026-09-01T12:00:00Z', url: 'https://github.com/x/y/releases/tag/v1.1.20', currentVersion: '2.0.0-beta.12',
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <WhatsNewModal isOpen onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("What's New shows the installed release", () => {
  beforeEach(() => {
    vi.mocked(api.getLatestRelease).mockResolvedValue(LATEST_STABLE as any);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("shows the installed beta's notes, not the latest stable's", async () => {
    vi.mocked(api.getCurrentRelease).mockResolvedValue({
      version: '2.0.0-beta.12', published: true, name: 'v2.0.0-beta.12', body: 'Notes for the installed beta',
      publishedAt: '2026-09-29T12:00:00Z', url: 'https://github.com/x/y/releases/tag/v2.0.0-beta.12', currentVersion: '2.0.0-beta.12',
    } as any);
    renderModal();
    expect(await screen.findByText('Notes for the installed beta')).toBeTruthy();
    expect(screen.queryByText('Notes for the latest stable')).toBeNull();
    expect(screen.getByRole('link', { name: /View on GitHub/ }).getAttribute('href')).toBe('https://github.com/x/y/releases/tag/v2.0.0-beta.12');
  });

  it('when the notes cannot be read, still links the releases page', async () => {
    vi.mocked(api.getCurrentRelease).mockRejectedValue(new Error('502'));
    renderModal();
    expect(await screen.findByText(/Unable to load release notes/)).toBeTruthy();
    await screen.findByRole('link', { name: /View on GitHub/ });
    expect(screen.getByRole('link', { name: /View on GitHub/ }).getAttribute('href')).toBe('https://github.com/x/y/releases');
  });

  it('says when the installed version has no published notes, and links the releases page', async () => {
    vi.mocked(api.getCurrentRelease).mockResolvedValue({
      version: '2.0.0-beta.13', published: false, name: '', body: '', publishedAt: null,
      url: 'https://github.com/x/y/releases', currentVersion: '2.0.0-beta.13',
    } as any);
    renderModal();
    expect(await screen.findByText(/No release notes were published for v2\.0\.0-beta\.13/)).toBeTruthy();
    expect(screen.queryByText('Notes for the latest stable')).toBeNull();
    expect(screen.getByRole('link', { name: /View on GitHub/ }).getAttribute('href')).toBe('https://github.com/x/y/releases');
  });
});
